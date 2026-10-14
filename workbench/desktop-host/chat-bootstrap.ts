type Bootstrap = { start(): Promise<void>; dispose(): Promise<void>; configurationMcpOverrides(): Promise<string[]>; getView(): { processActive: boolean } };
/** Delete failed owned run data only after confirmed child closure. */
export async function discoverChatMcp(bootstrap: Bootstrap, cleanup: () => Promise<void>): Promise<string[]> {
  let failure: unknown, overrides: string[] = [];
  try { await bootstrap.start(); overrides = await bootstrap.configurationMcpOverrides(); }
  catch (error) { failure = error; }
  try { await bootstrap.dispose(); }
  catch (error) {
    if (!bootstrap.getView().processActive) await cleanup();
    throw new Error("core-bootstrap-shutdown-unconfirmed", { cause: failure ?? error });
  }
  if (failure) { await cleanup(); throw failure; }
  return overrides;
}
