// Public mode: personal state is never automatically committed or pushed.
// Kept for subprocesses that need a local Git identity.
export const AGENT_GIT_ENV = {
  GIT_AUTHOR_NAME: "pangpang",
  GIT_AUTHOR_EMAIL: "pangpang@localhost",
  GIT_COMMITTER_NAME: "pangpang",
  GIT_COMMITTER_EMAIL: "pangpang@localhost",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
};
export async function commitGrowth(_summary: string): Promise<void> {}
export async function commitData(): Promise<void> {}
