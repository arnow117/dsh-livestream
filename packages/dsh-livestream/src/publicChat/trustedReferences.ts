import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { TrustedSenderReferences } from './trustedSender';

export interface TrustedHistoryReferences {
  senderBuildDeploymentFile: string;
  senderDeploymentFile: string;
}

/** 历史只需要受保护的构建与部署引用，不读取认证材料。 */
export function trustedHistoryReferencesFromEnvironment(env: NodeJS.ProcessEnv): TrustedHistoryReferences | null {
  const senderBuildDeploymentFile = env.DSH_PUBLIC_CHAT_BUILD_DEPLOYMENT_FILE;
  const senderDeploymentFile = env.DSH_PUBLIC_CHAT_DEPLOYMENT_FILE;
  if (!senderBuildDeploymentFile || !senderDeploymentFile) return null;
  if ([senderBuildDeploymentFile, senderDeploymentFile].some((path) => !isAbsolute(path) || resolve(path) !== path)) return null;
  return { senderBuildDeploymentFile, senderDeploymentFile };
}

/**
 * 这些引用仅取自主进程的受信部署环境；普通设置和模型不接收它们。
 * 材料文件本身只由经过验证的 helper launcher 以只读 FD 打开。
 */
export function trustedReferencesFromEnvironment(env: NodeJS.ProcessEnv,
  mode: 'frozen_http' | 'session_http' = 'frozen_http'): TrustedSenderReferences | null {
  const senderBuildDeploymentFile = env.DSH_PUBLIC_CHAT_BUILD_DEPLOYMENT_FILE;
  const senderDeploymentFile = env.DSH_PUBLIC_CHAT_DEPLOYMENT_FILE;
  const browserExecutable = env.DSH_PUBLIC_CHAT_BROWSER_EXECUTABLE ?? '';
  const manifestPath = env.DSH_PUBLIC_CHAT_HELPER_MANIFEST;
  const manifestSha256 = env.DSH_PUBLIC_CHAT_HELPER_MANIFEST_SHA256;
  const sourceDirectory = env.DSH_PUBLIC_CHAT_HELPER_SOURCE_DIRECTORY;
  const materialPath = env.DSH_PUBLIC_CHAT_MATERIAL_FILE;
  const dataDirectory = env.DSH_PUBLIC_CHAT_HELPER_DATA_DIR;
  if (!senderBuildDeploymentFile || !senderDeploymentFile || !manifestPath || !manifestSha256 || !sourceDirectory || !dataDirectory ||
    (mode === 'frozen_http' && (!browserExecutable || !materialPath))) return null;
  const paths = [senderBuildDeploymentFile, senderDeploymentFile, manifestPath, sourceDirectory, dataDirectory,
    ...(browserExecutable ? [browserExecutable] : []), ...(mode === 'frozen_http' && materialPath ? [materialPath] : [])];
  if (paths.some((path) => !isAbsolute(path) || resolve(path) !== path) || !/^[0-9a-f]{64}$/.test(manifestSha256)) return null;
  const created = new Map<string, { dev: number; ino: number }>();
  return {
    senderBuildDeploymentFile, senderDeploymentFile, browserExecutable,
    async helperReferences(senderProcessNonce, authContextRevision, identity) {
      const info = lstatSync(dataDirectory);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(dataDirectory) !== dataDirectory
        || (info.mode & 0o022) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
        throw new Error('unsafe helper data directory');
      }
      const common = { buildDigest: identity.buildDigest, instanceId: identity.instanceId, senderProcessNonce,
        accountRecordId: identity.accountRecordId, roomId: identity.roomId, authContextRevision };
      const bytes = Buffer.from(JSON.stringify(mode === 'session_http'
        ? { schemaVersion: 2, transportKind: 'session_http', ...common }
        : { ...common, principalUid: identity.expectedPrincipalUid }));
      const deploymentPath = join(dataDirectory, `.public-chat-helper-${randomBytes(16).toString('hex')}.json`);
      const fd = openSync(deploymentPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const createdInfo = fstatSync(fd);
        created.set(deploymentPath, { dev: createdInfo.dev, ino: createdInfo.ino });
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return { manifestPath, manifestSha256, sourceDirectory, materialPath: mode === 'frozen_http' ? materialPath : undefined,
        transportKind: mode, dataDirectory, deploymentPath, deploymentSha256: createHash('sha256').update(bytes).digest('hex') };
    },
    releaseReferences() {
      for (const [path, expected] of created) {
        try {
          const actual = lstatSync(path);
          if (actual.isFile() && !actual.isSymbolicLink() && actual.dev === expected.dev && actual.ino === expected.ino) unlinkSync(path);
        } catch {
          // A missing or replaced file is not ours to remove.
        }
        created.delete(path);
      }
    },
  };
}
