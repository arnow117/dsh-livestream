# FEAT-010 internal fixture

Run one scenario per invocation from `packages/dsh-livestream`, with a fresh,
already-created directory under the authorized `feat010-internal-integration-103`
workspace as `DSH_ACCEPTANCE_ROOT`. Set `DSH_ACCEPTANCE_SDK_ROOT` to the installed
SDK's `node_modules` directory and `DSH_ACCEPTANCE_ARTIFACT` to the accepted
registration read artifact. For the fixed-course scenario, also set
`DSH_ACCEPTANCE_COURSE_ROOT` to the explicitly authorized read-only lever-lab
directory. The runner refuses to overwrite a previous test snapshot.

For example, after setting those environment variables:

```sh
node test/acceptance/run.mjs --target desktop --grep 'held synthesis' --action-timeout 5000 --retries 0
```

Other scenario selectors are `host and course`, `fixed course`, `held model
result`, `explicit input`, `course reload`, and `already played`. Use a new
task directory for each invocation. The first selector can also run both
configured viewports by omitting `--target`. The tests retain the product's
existing ending fallback; they do not establish a new deadline for ending.

The fixture bundles the current plugin source and real Stage with a test-only
registration subprocess seam. It uses an installed SDK host, isolated test
identities, a local model protocol substitute and synthetic audio. Browser
owner requests use fixture credentials. An SDK-created guest Peer is passed
directly to route authorization; the SDK's public API does not publish a
non-owner HTTP peer, so browser guest admission is not established (the
unregistered guest is 401). No registration native binary, real model, real
voice service, platform or production sender is invoked. The separately built
production bundle is not the source fixture's loaded host artifact.

The default fixture's sender is unassembled. The separate offline Controller checks do
not prove an authorized sender path through the host or a real platform. The
private read checks cover the accepted T003 read subset, not profile writes.
The runner output, traces and screenshots describe this isolated fixture only;
they do not replace independent validation or a real live audience check.

### Same-host offline sender and standard artifacts

Set `DSH_ACCEPTANCE_SENDER_MODE=offline` for the `synthetic offline sender`,
`unknown synthetic sender`, `without matching raw proof`,
`authorization after input reconnect`, `held sender turn after actual end`,
and `owner public chat drawer` selectors. This mode loads the original
Douyin preset and replaces only `publicChatHost.ts`'s import of
`./trustedSender` during the test fixture build. The replacement constructs
original `TrustedHistory`, `TrustedSender`, `PublicChatInputBinding`, reply
tool, controller and journal with a synthetic frozen gateway. The gateway uses
the original `RawProofStore` with explicitly synthetic raw events and times.
The owner actions and the event, turn and tool association are the original
host code. Synthetic references, identities and sender results are test data;
production loader, helper, credentials and platform delivery are not tested.
The default mode retains the unassembled sender path.

The isolated standard build may be made with the existing `node build.mjs`
command and `DSH_LIVESTREAM_BUILD_OUT` pointing to a new task-owned `lib`
directory. Place it in a task-owned package directory with the package
manifest, `stage`, `assets` and installed dependencies available, then set
`DSH_ACCEPTANCE_STANDARD_PACKAGE` to that package directory and select
`unmodified standard artifacts`. The test loads the unmodified index and
agent with their shared chunks, and serves the actual client and stage scripts;
the recorded browser response hashes are checked against those files. Its
local model, bridge and TTS responses are protocol substitutes. Audio encoding
and probing are replaced only with an explicitly synthetic Node subprocess;
no native encoder, real voice service or production sender is invoked. With
`stagePort=0`, the original StageServer advertises its actual task-owned
listener. The test observes the built console's own preview receiving the same
audio-bearing event as the independent Stage and creating no audio player.

Additional selectors `all course reply segments` and `late ... after input` /
`late ... after stage` exercise synthetic audio results and disconnects.
They do not use a real speech provider or prove audible output. The runner
requires one selector and a fresh task root for each invocation. Retain the
runner log, trace and fixture shutdown line when reporting a result.
