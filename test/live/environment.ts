const WINDOWS_SYSTEM_VARIABLES = [
  'SystemRoot',
  'windir',
  'SystemDrive',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'PATHEXT',
  'ProgramFiles',
  'ProgramData',
  'NUMBER_OF_PROCESSORS',
] as const;

function environmentValue(name: string): string | undefined {
  const key = Object.keys(process.env).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? undefined : process.env[key];
}

export function isolatedEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: environmentValue('PATH'),
  };
  if (process.platform === 'win32') {
    for (const name of WINDOWS_SYSTEM_VARIABLES) {
      const value = environmentValue(name);
      if (value !== undefined) {
        environment[name] = value;
      }
    }
  }
  return { ...environment, ...overrides };
}
