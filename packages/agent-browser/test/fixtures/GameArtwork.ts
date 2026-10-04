import type { GameKind, GameState } from "./GameCore.ts";

/** Original canvas artwork. Serialized with the controller; no remote images or fonts. */
export const createGameArtwork = (canvas: HTMLCanvasElement) => {
  const context = canvas.getContext("2d");

  if (context === null) throw new Error("Canvas unavailable");

  const background = document.createElement("canvas");

  background.width = 960;
  background.height = 540;
  const scene = background.getContext("2d");

  if (scene === null) throw new Error("Artwork canvas unavailable");

  const rounded = (
    target: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    fill: string | CanvasGradient,
    stroke?: string,
  ) => {
    target.beginPath();
    target.roundRect(x, y, width, height, radius);
    target.fillStyle = fill;
    target.fill();
    if (stroke !== undefined) {
      target.strokeStyle = stroke;
      target.lineWidth = 2;
      target.stroke();
    }
  };

  const gradient = (
    target: CanvasRenderingContext2D,
    y: number,
    height: number,
    colors: readonly string[],
  ) => {
    const fill = target.createLinearGradient(0, y, 0, y + height);

    colors.forEach((color, index) => fill.addColorStop(index / (colors.length - 1), color));

    return fill;
  };

  const text = (
    target: CanvasRenderingContext2D,
    value: string,
    x: number,
    y: number,
    size: number,
    color: string,
    face = "sans-serif",
  ) => {
    target.font = `bold ${size}px ${face}`;
    target.fillStyle = color;
    target.fillText(value, x, y);
  };

  const polygon = (
    target: CanvasRenderingContext2D,
    points: readonly (readonly [number, number])[],
    fill: string | CanvasGradient,
    stroke?: string,
  ) => {
    target.beginPath();
    points.forEach(([x, y], index) => {
      if (index === 0) target.moveTo(x, y);
      else target.lineTo(x, y);
    });
    target.closePath();
    target.fillStyle = fill;
    target.fill();
    if (stroke !== undefined) {
      target.strokeStyle = stroke;
      target.lineWidth = 2;
      target.stroke();
    }
  };

  scene.fillStyle = gradient(scene, 0, 540, ["#241447", "#342354", "#117d87", "#062b45"]);
  scene.fillRect(0, 0, 960, 540);
  const halo = scene.createRadialGradient(488, 177, 0, 488, 177, 490);

  halo.addColorStop(0, "#9161a866");
  halo.addColorStop(1, "#19132b00");
  scene.fillStyle = halo;
  scene.fillRect(0, 0, 960, 440);
  for (let star = 0; star < 70; star++) {
    const x = (star * 137 + 23) % 960;
    const y = (star * 73 + 19) % 380;

    scene.fillStyle = star % 3 === 0 ? "#fff1c7aa" : "#b7e6ff55";
    scene.beginPath();
    scene.arc(x, y, star % 3 === 0 ? 1.5 : 0.8, 0, Math.PI * 2);
    scene.fill();
  }

  // Moonlit temple columns, flowing water and an original crowned guardian.
  for (const x of [12, 177, 788, 926]) {
    rounded(scene, x, 88, 26, 312, 5, gradient(scene, 88, 312, ["#a3bed4", "#4a708e", "#223f64"]));
    for (let flute = 0; flute < 4; flute++) {
      scene.fillStyle = "#112a4d66";
      scene.fillRect(x + 4 + flute * 5, 106, 2, 273);
    }
    rounded(scene, x - 6, 83, 38, 18, 3, "#cab28a", "#efe1b1");
    rounded(scene, x - 8, 388, 42, 18, 3, "#6f9eac", "#cae1c5");
  }
  for (let wave = 0; wave < 5; wave++) {
    scene.beginPath();
    scene.moveTo(0, 350 + wave * 16);
    scene.bezierCurveTo(190, 320 + wave * 16, 315, 412 + wave * 12, 520, 359 + wave * 16);
    scene.bezierCurveTo(700, 320 + wave * 16, 790, 400 + wave * 13, 960, 351 + wave * 16);
    scene.lineTo(960, 440);
    scene.lineTo(0, 440);
    scene.fillStyle = wave % 2 === 0 ? "#154f68" : "#187e87";
    scene.fill();
    scene.strokeStyle = "#9de3d522";
    scene.stroke();
  }
  scene.save();
  scene.translate(117, 190);
  polygon(
    scene,
    [
      [-72, 203],
      [-67, 73],
      [-31, 26],
      [31, 26],
      [67, 73],
      [82, 203],
    ],
    gradient(scene, 25, 180, ["#8357b0", "#32194e"]),
    "#dfc68f",
  );
  polygon(
    scene,
    [
      [-44, 186],
      [-32, 37],
      [0, 60],
      [31, 37],
      [44, 186],
    ],
    "#207e85",
    "#83d0bb",
  );
  polygon(
    scene,
    [
      [-65, 81],
      [-29, 44],
      [-19, 57],
      [-48, 108],
    ],
    "#e9bc68",
    "#fff0ac",
  );
  polygon(
    scene,
    [
      [65, 81],
      [29, 44],
      [19, 57],
      [48, 108],
    ],
    "#e9bc68",
    "#fff0ac",
  );
  rounded(scene, -17, 10, 34, 47, 12, gradient(scene, 10, 47, ["#bce7dd", "#5799ac"]));
  scene.beginPath();
  scene.ellipse(0, -10, 39, 57, 0, 0, Math.PI * 2);
  scene.fillStyle = gradient(scene, -67, 114, ["#28354f", "#172c41"]);
  scene.fill();
  scene.beginPath();
  scene.ellipse(0, -5, 27, 41, 0, 0, Math.PI * 2);
  scene.fillStyle = gradient(scene, -46, 82, ["#d2f0de", "#68a8b3"]);
  scene.fill();
  scene.strokeStyle = "#274f63";
  scene.lineWidth = 2;
  for (const side of [-1, 1]) {
    scene.beginPath();
    scene.moveTo(side * 6, -12);
    scene.quadraticCurveTo(side * 15, -18, side * 23, -12);
    scene.stroke();
    scene.fillStyle = "#203850";
    scene.beginPath();
    scene.ellipse(side * 14, -10, 4, 2, 0, 0, Math.PI * 2);
    scene.fill();
  }
  scene.beginPath();
  scene.moveTo(0, -4);
  scene.lineTo(-4, 10);
  scene.lineTo(3, 10);
  scene.stroke();
  scene.beginPath();
  scene.moveTo(-8, 20);
  scene.quadraticCurveTo(0, 24, 9, 20);
  scene.stroke();
  polygon(
    scene,
    [
      [-40, -44],
      [-43, -72],
      [-22, -59],
      [0, -98],
      [22, -59],
      [43, -72],
      [40, -44],
    ],
    gradient(scene, -98, 60, ["#fff1bd", "#c79139"]),
    "#ffeb9a",
  );
  polygon(
    scene,
    [
      [0, -78],
      [10, -58],
      [0, -43],
      [-10, -58],
    ],
    "#5ef4e4",
    "#ecfff5",
  );
  rounded(scene, -40, -49, 80, 9, 4, "#ddaf54", "#ffe8a0");
  scene.beginPath();
  scene.arc(0, 81, 22, 0, Math.PI * 2);
  scene.fillStyle = "#ddb769";
  scene.fill();
  scene.beginPath();
  scene.arc(0, 81, 16, 0, Math.PI * 2);
  scene.fillStyle = "#4ad6cb";
  scene.fill();
  for (const side of [-1, 1]) {
    polygon(
      scene,
      [
        [side * 58, 90],
        [side * 46, 156],
        [side * 32, 171],
        [side * 38, 144],
      ],
      "#91cbc4",
      "#d5e6cf",
    );
  }
  scene.restore();

  scene.textAlign = "center";
  scene.shadowColor = "#130d29";
  scene.shadowBlur = 5;
  text(scene, "TEMPLE OF", 490, 27, 17, "#fff3d0", "Georgia");
  text(scene, "TIDES", 490, 62, 38, "#f7d68d", "Georgia");
  scene.shadowBlur = 0;
  text(scene, "ESTUARY", 110, 38, 14, "#a6d8d6");
  rounded(scene, 793, 22, 142, 30, 15, "#211b37bb", "#b59d65");
  text(scene, "DEMO PLAY", 864, 42, 12, "#fce2ab");

  rounded(
    scene,
    222,
    73,
    553,
    354,
    19,
    gradient(scene, 73, 354, ["#fff0b8", "#b58238", "#ffe3a0", "#90682e"]),
    "#f4db99",
  );
  rounded(scene, 231, 82, 535, 336, 12, "#2d1f43", "#593a6d");
  rounded(scene, 239, 89, 519, 322, 7, gradient(scene, 89, 322, ["#332252", "#1d1d3a"]), "#81609a");
  for (let reel = 1; reel < 6; reel++) {
    scene.fillStyle = "#d3ace516";
    scene.fillRect(244 + reel * 85, 93, 1, 313);
  }
  for (const [x, y] of [
    [231, 82],
    [766, 82],
    [231, 418],
    [766, 418],
  ]) {
    if (x === undefined || y === undefined) continue;
    polygon(
      scene,
      [
        [x, y - 9],
        [x + 9, y],
        [x, y + 9],
        [x - 9, y],
      ],
      "#90f4df",
      "#fff0bc",
    );
  }
  rounded(
    scene,
    800,
    106,
    128,
    132,
    50,
    gradient(scene, 106, 132, ["#65417c", "#231937"]),
    "#c5a565",
  );
  text(scene, "LAST WIN", 864, 139, 12, "#d8c1e5");
  text(scene, "DEMO CREDITS", 864, 215, 10, "#b6b0d0");
  text(scene, "SIX JEWELS", 864, 279, 14, "#f5dca0", "Georgia");
  text(scene, "ONE TEMPLE", 864, 302, 14, "#f5dca0", "Georgia");
  text(scene, "Demo credits only", 110, 416, 12, "#d4ebdf");

  rounded(scene, 14, 435, 932, 88, 13, gradient(scene, 435, 88, ["#251a38", "#100f24"]), "#79613b");
  scene.textAlign = "left";
  text(scene, "BALANCE", 35, 455, 11, "#aaa5bd");
  text(scene, "LAST WIN", 210, 455, 11, "#aaa5bd");
  scene.textAlign = "center";
  text(scene, "TOTAL BET", 445, 457, 11, "#bdb0ce");
  text(scene, "SPACE TO SPIN  ·  ↑ ↓ ADJUST BET", 478, 535, 10, "#a5a7bd");

  const colors = ["#34b3f4", "#55d492", "#fa677d", "#b779fb", "#ffc652", "#57e5dc"];

  const symbols = colors.map((color, index) => {
    const image = document.createElement("canvas");

    image.width = 100;
    image.height = 100;
    const target = image.getContext("2d");

    if (target === null) throw new Error("Symbol canvas unavailable");
    target.translate(50, 50);
    target.shadowColor = "#000000aa";
    target.shadowBlur = 7;
    target.shadowOffsetY = 4;
    const gem = gradient(target, -36, 72, ["#ffffff", color, "#29214c"]);
    let points: readonly (readonly [number, number])[];

    switch (index) {
      case 0:
        points = [
          [-24, -28],
          [24, -28],
          [37, -9],
          [0, 36],
          [-37, -9],
        ];
        break;
      case 1:
        points = [
          [-20, -33],
          [20, -33],
          [33, -13],
          [33, 15],
          [19, 33],
          [-19, 33],
          [-33, 15],
          [-33, -13],
        ];
        break;
      case 2:
        points = [
          [0, -34],
          [32, -15],
          [27, 23],
          [0, 36],
          [-27, 23],
          [-32, -15],
        ];
        break;
      case 3:
        points = [
          [0, -38],
          [36, 27],
          [0, 34],
          [-36, 27],
        ];
        break;
      case 4:
        points = Array.from({ length: 10 }, (_, corner): readonly [number, number] => {
          const angle = -Math.PI / 2 + (corner * Math.PI) / 5;
          const radius = corner % 2 === 0 ? 38 : 20;

          return [Math.cos(angle) * radius, Math.sin(angle) * radius];
        });
        break;
      default:
        points = [
          [0, -35],
          [17, -20],
          [35, -23],
          [29, 4],
          [35, 29],
          [0, 19],
          [-35, 29],
          [-29, 4],
          [-35, -23],
          [-17, -20],
        ];
    }
    polygon(target, points, gem, "#fff4d5");
    target.shadowBlur = 0;
    target.shadowOffsetY = 0;
    points.forEach(([x, y], corner) => {
      const next = points[(corner + 1) % points.length];

      if (next === undefined) return;
      polygon(
        target,
        [[0, -3], [x, y], next],
        corner % 3 === 0 ? "#ffffff77" : corner % 3 === 1 ? "#ffffff15" : "#1f124f44",
      );
    });
    polygon(
      target,
      [
        [-13, -14],
        [12, -14],
        [16, 8],
        [0, 18],
        [-16, 8],
      ],
      color,
      "#ffffff77",
    );
    polygon(
      target,
      [
        [-19, -23],
        [-8, -20],
        [-15, -9],
      ],
      "#ffffffdd",
    );
    target.strokeStyle = "#ffffffdd";
    target.lineWidth = 1.5;
    target.beginPath();
    target.moveTo(21, -33);
    target.lineTo(21, -21);
    target.moveTo(15, -27);
    target.lineTo(27, -27);
    target.stroke();

    return image;
  });

  return (state: GameState, time: number, kind: GameKind) => {
    context.drawImage(background, 0, 0);
    context.save();
    context.beginPath();
    context.rect(243, 93, 511, 313);
    context.clip();
    for (let reel = 0; reel < 6; reel++) {
      const moving = state.phase === "spinning" && reel >= state.stoppedReels;
      const offset = moving ? (time * 0.85 + reel * 19) % 63 : 0;
      const cycle = Math.floor((time * 0.85 + reel * 19) / 63);

      for (let row = moving ? -1 : 0; row < 5; row++) {
        const symbol = moving ? (cycle + row + reel + 6000) % 6 : (state.grid[reel]?.[row] ?? 0);
        const image = symbols[symbol];
        const x = 250 + reel * 85;
        const y = 90 + row * 63 + offset;

        if (state.phase === "result" && state.lastWin > 0 && row === 2) {
          rounded(context, x - 2, y + 3, 77, 60, 10, "#f8cc5533", "#ffdf77");
        }
        if (image !== undefined) {
          if (moving) {
            context.globalAlpha = 0.18;
            context.drawImage(image, x + 3, y - 12, 68, 68);
            context.globalAlpha = 1;
          }
          context.drawImage(image, x + 3, y, 68, 68);
        }
      }
    }
    context.restore();
    context.textAlign = "center";
    text(context, `${state.lastWin}`, 864, 184, 33, "#fff0bc", "Georgia");
    text(context, `SPIN ${state.spin}`, 864, 335, 11, "#c7b9d3");

    if (kind === "reels") {
      context.textAlign = "left";
      text(context, `${state.balance}`, 35, 488, 28, "#f8e4b6");
      text(context, `${state.lastWin}`, 210, 488, 28, "#f8e4b6");
      text(context, "demo credits", 35, 507, 10, "#aaa5bd");
      for (const [x, label] of [
        [340, "−"],
        [490, "+"],
      ] as const) {
        rounded(
          context,
          x,
          440,
          60,
          75,
          12,
          gradient(context, 440, 75, ["#4b385c", "#241d35"]),
          "#a48c65",
        );
        context.textAlign = "center";
        text(context, label, x + 30, 488, 28, "#ffe7b1");
      }
      text(context, `${state.bet}`, 445, 490, 28, "#fff0c6");
      rounded(
        context,
        700,
        440,
        230,
        75,
        37,
        gradient(
          context,
          440,
          75,
          state.phase === "idle" ? ["#ffe7a6", "#daa64a", "#b57728"] : ["#806a68", "#49374d"],
        ),
        "#fff0b3",
      );
      context.beginPath();
      context.arc(740, 477, 20, Math.PI * 0.2, Math.PI * 1.8);
      context.strokeStyle = state.phase === "idle" ? "#402c34" : "#d9c5bb";
      context.lineWidth = 3;
      context.stroke();
      polygon(
        context,
        [
          [758, 464],
          [748, 460],
          [756, 453],
        ],
        context.strokeStyle,
      );
      text(
        context,
        state.phase === "idle" ? "SPIN" : state.phase === "spinning" ? "SPINNING" : "RESULT",
        831,
        486,
        state.phase === "spinning" ? 19 : 24,
        state.phase === "idle" ? "#3b2331" : "#f5e2ce",
      );
    }

    if (state.banner !== null) {
      const glow = 0.88 + Math.sin(time / 110) * 0.12;

      context.save();
      for (let particle = 0; particle < 24; particle++) {
        const x = 257 + ((particle * 71) % 480);
        const y = 108 + ((particle * 47 - time * 0.045 + 100000) % 287);
        const size = (particle % 3) + 2;

        polygon(
          context,
          [
            [x, y - size],
            [x + size, y],
            [x, y + size],
            [x - size, y],
          ],
          "#ffeab7cc",
        );
      }
      context.globalAlpha = glow;
      context.shadowBlur = 26;
      context.shadowColor = "#ffd76c";
      rounded(
        context,
        298,
        180,
        398,
        126,
        23,
        gradient(context, 180, 126, ["#52305aee", "#271b3cf5"]),
        "#ffdf80",
      );
      context.shadowBlur = 0;
      text(
        context,
        state.banner === "bonus" ? "TEMPLE BONUS" : state.banner === "big-win" ? "BIG WIN" : "WIN",
        497,
        216,
        23,
        "#ffde84",
        "Georgia",
      );
      text(context, `+${state.lastWin}`, 497, 269, 48, "#fff2bf", "Georgia");
      context.restore();
    }
  };
};
