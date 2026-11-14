import { BrowserManager } from '@dsh-fixed-d/browser';
import { LiveSession } from '@dsh-fixed-d/session';
import { decodeMessageBody } from '@dsh-fixed-d/proto';
import { RawSenderSession } from '../rawSenderSession.ts';

export { FrozenSenderRuntime } from '../frozenSenderRuntime.ts';
export { SenderService } from '../senderService.ts';
export { SenderClient, readSenderDeploymentFile } from '../senderClient.ts';
export { PublicChatSendController } from '../controller.ts';
export { FrozenPublicChatOperationJournal } from '../frozenJournal.ts';
export { launchHelper } from '../helperLauncher.ts';
export { PublicChatInputBinding } from '../inputBinding.ts';
export { createPublicChatReplyTool } from '../agentReplyTool.ts';

/** Decode only the original fixed-source raw message; no caller-supplied room proof. */
export function decodeFixedRaw(message) {
  return decodeMessageBody(message)?.body ?? null;
}

/** Browser and session are owned here; no legacy page-write object is returned. */
export function createFixedRawSession({ roomId, runtime, executablePath }) {
  return new RawSenderSession({
    roomId,
    runtime,
    createBrowser: () => new BrowserManager({ executablePath, headless: true }),
    createSession: (fixedRoomId, page, cdp, options, context) =>
      new LiveSession(fixedRoomId, page, cdp, options, context),
  });
}
