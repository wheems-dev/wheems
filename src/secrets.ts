import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * Credentials, by name: `secrets.slack.bot_token`. They live in a private file on
 * this machine (mode 600), outside the install folder, and never pass through an
 * agent. The encrypted secret store comes in milestone 8.
 */
export type Secrets = Record<string, Record<string, string>>;

const secretsSchema = z.record(z.string(), z.record(z.string(), z.string()));

export async function readSecrets(file: string): Promise<Secrets> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed = secretsSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${file} is not a secrets file Opinr can read`);
  return parsed.data;
}

/** Sets one secret's fields and saves the file privately. */
export async function writeSecret(
  file: string,
  name: string,
  values: Record<string, string>,
): Promise<void> {
  const secrets = await readSecrets(file);
  secrets[name] = { ...secrets[name], ...values };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
}
