/**
 * The page viewers open: a browser window drawn around the motion-JPEG picture, with the
 * address, tab title and caption set from server-sent events.
 *
 * The screencast shows only the page, never the browser around it, so the window is drawn here
 * from the facts the server sends as each moment airs. Every value is page-derived and
 * untrusted, so each is set with `textContent` and never parsed as markup.
 */
export const viewer = `<!doctype html><meta charset="utf-8"><title>Live browser</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1f2124;font:13px system-ui,sans-serif}
.window{width:min(96vw,1280px);border-radius:10px;overflow:hidden;background:#dee1e6;box-shadow:0 18px 60px rgba(0,0,0,.5)}
.tabs{display:flex;align-items:end;gap:8px;padding:8px 12px 0}
.dots{display:flex;gap:6px;padding:0 8px 10px 0}.dots i{width:12px;height:12px;border-radius:50%;background:#ff5f57}.dots i+i{background:#febc2e}.dots i+i+i{background:#28c840}
.tab{max-width:240px;padding:8px 14px;border-radius:8px 8px 0 0;background:#fff;color:#1f1f1f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar{display:flex;align-items:center;gap:10px;padding:6px 10px;background:#fff;color:#5f6368}
.address{flex:1;padding:6px 14px;border-radius:16px;background:#f1f3f4;color:#1f1f1f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.screen{position:relative;background:#fff;line-height:0}
.screen img{width:100%;display:block}
.caption{position:absolute;left:50%;bottom:6%;transform:translateX(-50%);max-width:80%;padding:8px 16px;border-radius:8px;background:rgba(0,0,0,.8);color:#fff;font:500 20px/1.35 system-ui,sans-serif;text-align:center;line-height:1.35}
.caption:empty{display:none}
</style>
<div class="window">
  <div class="tabs"><span class="dots"><i></i><i></i><i></i></span><span class="tab" id="title">New Tab</span></div>
  <div class="bar"><span>&#8592;</span><span>&#8594;</span><span>&#8635;</span><span class="address" id="address"></span></div>
  <div class="screen"><img src="/live.mjpeg" alt="The browser, as it was a moment ago"><div class="caption" id="caption" aria-live="polite"></div></div>
</div>
<script>
const set = (id, value) => { document.getElementById(id).textContent = value ?? ""; };
new EventSource("/events").addEventListener("state", (event) => {
  const state = JSON.parse(event.data);
  set("address", state.address);
  set("title", state.title ?? state.address ?? "New Tab");
  set("caption", state.caption);
});
</script>`;
