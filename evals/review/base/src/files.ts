import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// The absolute path for an attachment, or a throw when it would land outside
// `root`. The separator matters: `/data/up` must not admit `/data/uploads-x`.
export function resolveUploadPath(root: string, invoiceId: string, name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid attachment name: ${name}`);
  const base = resolve(root);
  const target = resolve(base, invoiceId, name);
  if (!target.startsWith(base + sep)) throw new Error("attachment path escapes the upload root");
  return target;
}

export async function saveAttachment(
  root: string,
  invoiceId: string,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  const target = resolveUploadPath(root, invoiceId, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return target;
}
