export interface TestCredentials {
  username: string;
  password: string;
}

function credentials(username: string | undefined, password: string | undefined) {
  if (!username || !password) return null;
  return { username, password } satisfies TestCredentials;
}

export function adminCredentials(): TestCredentials | null {
  return credentials(process.env.BUHLOS_TEST_ADMIN_EMAIL, process.env.BUHLOS_TEST_ADMIN_PASSWORD);
}

export function fieldCredentials(): TestCredentials | null {
  return credentials(process.env.BUHLOS_TEST_FIELD_EMAIL, process.env.BUHLOS_TEST_FIELD_PASSWORD);
}

export function createSmokeJobName(): string {
  return `SMOKE_TEST_${process.env.TEST_RUN_ID ?? "local"}_Job_Builder`;
}
