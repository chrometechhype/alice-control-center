let shutdownHandler: (() => void) | null = null;

export function setShutdownHandler(handler: () => void): void {
  shutdownHandler = handler;
}

export function shutdownForUpdate(): void {
  if (shutdownHandler) {
    shutdownHandler();
    return;
  }
  process.exit(0);
}
