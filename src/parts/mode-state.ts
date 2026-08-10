export type Mode = "build" | "auto" | "plan";

let currentMode: Mode = "build";

export function getMode(): Mode {
  return currentMode;
}

export function setCurrentMode(mode: Mode): void {
  currentMode = mode;
}
