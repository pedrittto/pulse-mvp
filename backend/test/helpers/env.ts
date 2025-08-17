// Test helper for environment variable isolation

let originalEnv: NodeJS.ProcessEnv;

export const snapshotEnv = () => {
  originalEnv = { ...process.env };
};

export const restoreEnv = () => {
  if (originalEnv) {
    process.env = { ...originalEnv };
  }
};

export const setTestEnv = (env: Record<string, string>) => {
  Object.assign(process.env, env);
};

export const clearTestEnv = (keys: string[]) => {
  keys.forEach(key => {
    delete process.env[key];
  });
};
