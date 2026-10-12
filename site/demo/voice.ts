// The agent's voice: each line spoken by an OpenRouter audio model, which streams 24 kHz 16-bit
// mono PCM. The line is the caption; the voice is asked to read it as written and trusted to.
// Spending has its own cap, since OpenRouter streams audio only, outside the bench's budgeted,
// non-streaming client.
import { Config, Effect, Redacted, Ref, Schema, Stream } from "effect";
import * as Sse from "effect/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/http";

export class VoiceError extends Schema.TaggedError<VoiceError>()("VoiceError", {
  message: Schema.String,
}) {}

export const sampleRate = 24_000;

/** Milliseconds of 16-bit mono PCM at the voice's rate. */
export const millisOf = (pcm: Uint8Array) => (pcm.length / 2 / sampleRate) * 1000;

export interface VoiceOptions {
  readonly model: string;
  readonly voice: string;
  /** USD for every line together; a line that could take the total past it is refused. */
  readonly maxUsd: number;
}

export const defaults = { model: "openai/gpt-audio-mini", voice: "marin" } as const;

/** Listed prices of the default model, USD per token: its text in and audio out. */
const rates = { input: 0.6e-6, output: 2.4e-6 };

/** About a minute of speech, at some 20 audio tokens a second: far longer than any line. */
const maxTokens = 1200;

/** What one line can cost at most: its instructions and words in, its audio out. */
const bound = 400 * rates.input + maxTokens * rates.output;

const instructions = [
  "You are the voice of someone talking over their own screen recording as they use a computer.",
  "Read the user's message aloud exactly as written, word for word, adding nothing and leaving",
  "nothing out. Relaxed, natural and engaged, like thinking aloud, at a brisk conversational pace.",
].join(" ");

const Chunk = Schema.Struct({
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        delta: Schema.optional(
          Schema.Struct({
            audio: Schema.optional(Schema.Struct({ data: Schema.optional(Schema.String) })),
          }),
        ),
      }),
    ),
  ),
  usage: Schema.optional(Schema.Struct({ cost: Schema.optional(Schema.Finite) })),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
});

const decodeChunk = Schema.decodeUnknownEffect(Schema.fromJsonString(Chunk));

interface Heard {
  /** Base64 PCM, as streamed. */
  readonly audio: string;
  /** What OpenRouter charged, once its usage arrives. */
  readonly cost: number | undefined;
}

export interface Spoken {
  readonly pcm: Uint8Array;
  readonly millis: number;
}

export const make = Effect.fn("Voice.make")(function* (options: VoiceOptions) {
  const client = yield* HttpClient.HttpClient;
  const key = yield* Config.Redacted("OPENROUTER_API_KEY");
  const spent = yield* Ref.make(0);

  const request = (line: string) =>
    HttpClientRequest.post("https://openrouter.ai/api/v1/chat/completions").pipe(
      HttpClientRequest.bearerToken(Redacted.value(key)),
      HttpClientRequest.bodyJsonUnsafe({
        model: options.model,
        modalities: ["text", "audio"],
        audio: { voice: options.voice, format: "pcm16" },
        stream: true,
        max_tokens: maxTokens,
        usage: { include: true },
        provider: { data_collection: "deny" },
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: line },
        ],
      }),
    );

  /** One attempt: the audio and what OpenRouter charged. */
  const attempt = (line: string) =>
    client.execute(request(line)).pipe(
      Effect.filterOrFail(
        (response) => response.status === 200,
        (response) => new VoiceError({ message: `the voice answered ${response.status}` }),
      ),
      Effect.flatMap((response) =>
        response.stream.pipe(
          Stream.decodeText(),
          Stream.pipeThroughChannel(Sse.decode()),
          Stream.map((event) => event.data),
          Stream.takeWhile((data) => data !== "[DONE]"),
          Stream.mapEffect((data) =>
            decodeChunk(data).pipe(
              Effect.filterOrFail(
                (chunk) => chunk.error === undefined,
                (chunk) => new VoiceError({ message: `the voice failed: ${chunk.error?.message}` }),
              ),
            ),
          ),
          Stream.runFold(
            (): Heard => ({ audio: "", cost: undefined }),
            (state, chunk): Heard => ({
              audio: state.audio + (chunk.choices?.[0]?.delta?.audio?.data ?? ""),
              cost: chunk.usage?.cost ?? state.cost,
            }),
          ),
        ),
      ),
      Effect.mapError((error) =>
        Schema.is(VoiceError)(error)
          ? error
          : new VoiceError({ message: `the voice failed: ${error._tag}` }),
      ),
    );

  /** Speak one line, trying again once if the request fails. */
  const speak = Effect.fn("Voice.speak")(function* (line: string) {
    const once = Effect.gen(function* () {
      if ((yield* Ref.get(spent)) + bound > options.maxUsd)
        return yield* new VoiceError({
          message: `another line could take the voice past its $${options.maxUsd} cap`,
        });

      const heard = yield* attempt(line).pipe(
        // An attempt that failed after sending may have been charged: count it at its bound.
        Effect.tapError(() => Ref.update(spent, (usd) => usd + bound)),
      );

      yield* Ref.update(spent, (usd) => usd + (heard.cost ?? bound));
      const pcm = Uint8Array.from(Buffer.from(heard.audio, "base64"));

      if (pcm.length === 0) return yield* new VoiceError({ message: "the voice sent no audio" });

      return { pcm, millis: millisOf(pcm) };
    });

    return yield* once.pipe(Effect.retry({ times: 1 }));
  });

  return { speak, spent: Ref.get(spent), credit: `${options.model}, voice ${options.voice}` };
});

export type Voice = Effect.Success<ReturnType<typeof make>>;
