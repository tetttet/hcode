import { readFileSync } from "node:fs";
import animatedLogoPath from "../assets/yahya-loader.gif" with {
  type: "file",
};
import staticLogoPath from "../assets/yahya-logo.png" with { type: "file" };

const KITTY_IMAGE_ID = 729_401;
const animatedLogoBytes = readFileSync(animatedLogoPath);
const staticLogoBytes = readFileSync(staticLogoPath);

export const YAHYA_TEXT_LOGO_FRAMES = [
  "⣰⠞",
  "⠴⠶",
  "⠶⠦",
  "⠳⣆",
  "⢸⡆",
  "⢸⠇",
  "⡴⠏",
  "⠶⠖",
  "⠲⠶",
  "⠹⢦",
  "⠸⡇",
  "⢰⡇",
] as const;

export interface TerminalLogo {
  imageSequence: string | null;
  cleanupSequence: string;
  columns: number;
}

type ImageProtocol = "iterm" | "kitty" | "text";

function requestedProtocol(): ImageProtocol | null {
  const value = process.env.HCODE_IMAGE_PROTOCOL?.trim().toLowerCase();
  if (value === "iterm" || value === "kitty" || value === "text") {
    return value;
  }
  return null;
}

function detectedProtocol(): ImageProtocol {
  if (process.env.TMUX) {
    return "text";
  }

  const terminal = [
    process.env.TERM_PROGRAM,
    process.env.LC_TERMINAL,
    process.env.TERM,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    process.env.ITERM_SESSION_ID ||
    process.env.WEZTERM_EXECUTABLE ||
    process.env.WARP_IS_LOCAL_SHELL_SESSION ||
    /iterm|wezterm|warp/.test(terminal)
  ) {
    return "iterm";
  }

  if (
    process.env.KITTY_WINDOW_ID ||
    process.env.GHOSTTY_RESOURCES_DIR ||
    /kitty|ghostty/.test(terminal)
  ) {
    return "kitty";
  }

  return "text";
}

function itermLogo(): TerminalLogo {
  const payload = Buffer.from(animatedLogoBytes).toString("base64");
  const name = Buffer.from("yahya-loader.gif").toString("base64");
  const parameters = [
    `name=${name}`,
    `size=${animatedLogoBytes.byteLength}`,
    "width=2",
    "height=1",
    "preserveAspectRatio=1",
    "inline=1",
  ].join(";");

  return {
    imageSequence: `\x1b]1337;File=${parameters}:${payload}\x07`,
    cleanupSequence: "",
    columns: 2,
  };
}

function kittyLogo(): TerminalLogo {
  const payload = Buffer.from(staticLogoBytes).toString("base64");
  return {
    imageSequence:
      `\x1b_Ga=T,f=100,t=d,c=2,r=1,C=1,q=2,i=${KITTY_IMAGE_ID};` +
      `${payload}\x1b\\`,
    cleanupSequence: `\x1b_Ga=d,d=I,i=${KITTY_IMAGE_ID},q=2;\x1b\\`,
    columns: 2,
  };
}

export function createTerminalLogo(): TerminalLogo {
  const protocol = requestedProtocol() ?? detectedProtocol();
  if (protocol === "iterm") {
    return itermLogo();
  }
  if (protocol === "kitty") {
    return kittyLogo();
  }
  return { imageSequence: null, cleanupSequence: "", columns: 2 };
}
