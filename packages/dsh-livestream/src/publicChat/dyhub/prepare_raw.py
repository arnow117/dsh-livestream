#!/usr/bin/env python3
"""Export and verify the fixed DyHub raw-only source into a new owned directory."""

import argparse
import hashlib
import io
import json
import pathlib
import re
import subprocess
import tarfile

COMMIT = '3a79c57d85c59289db3b77211b3ec01fae47d42c'
PATCH_SHA256 = '65de3588dbff5f9fa11f2cc86bbdf785c9303919113f146f8e21c7802b2d08e0'
ORIGINALS = {
    'src/collector/browser.ts': 'a6d88ce96467b6f2e9f421faf1bc1725067bff9b0ede9c4b90218a9ee35de3a8',
    'src/collector/liveSession.ts': 'c06e4997cb7898de8eae1731fb42e52e2463404bc4a8859b8606ffbafb56f879',
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def apply_exact(source_text, patch_lines):
    source = source_text.splitlines(keepends=True)
    result = list(source)
    offset = 0
    index = 0
    while index < len(patch_lines):
        header = re.fullmatch(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*\n', patch_lines[index])
        if header is None:
            raise ValueError('invalid hunk header')
        index += 1
        before = []
        after = []
        while index < len(patch_lines) and not patch_lines[index].startswith('@@ '):
            line = patch_lines[index]
            if not line or line[0] not in ' +-':
                raise ValueError('invalid hunk line')
            if line[0] in ' -':
                before.append(line[1:])
            if line[0] in ' +':
                after.append(line[1:])
            index += 1
        if len(before) != int(header.group(2) or 1) or len(after) != int(header.group(4) or 1):
            raise ValueError('invalid hunk length')
        expected = int(header.group(1)) - 1
        matches = [i for i in range(len(source) - len(before) + 1) if source[i:i + len(before)] == before]
        if matches != [expected]:
            raise ValueError('patch context missing or not unique')
        position = expected + offset
        if result[position:position + len(before)] != before:
            raise ValueError('overlapping or changed hunk')
        result[position:position + len(before)] = after
        offset += len(after) - len(before)
    return ''.join(result)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if args.baseline != COMMIT:
        raise ValueError('baseline mismatch')
    repo = pathlib.Path(args.repo)
    output = pathlib.Path(args.output)
    if not repo.is_absolute() or repo.resolve(strict=True) != repo or not repo.is_dir():
        raise ValueError('unsafe source repository')
    if not output.is_absolute() or output.parent.resolve(strict=True) != output.parent or output.exists() or output.is_symlink():
        raise ValueError('unsafe or existing output')
    patch = pathlib.Path(__file__).with_name('raw-only.patch').read_bytes()
    if sha256(patch) != PATCH_SHA256:
        raise ValueError('patch digest mismatch')
    archive = subprocess.run(['git', 'archive', '--format=tar', COMMIT], cwd=repo,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:') as tar:
        originals = {}
        for name, expected in ORIGINALS.items():
            member = tar.getmember(name)
            if not member.isfile():
                raise ValueError('source is not a regular file')
            data = tar.extractfile(member).read()
            if sha256(data) != expected:
                raise ValueError('source baseline mismatch')
            originals[name] = data.decode('utf-8')
        lines = patch.decode('utf-8').splitlines(keepends=True)
        changes = {}
        index = 0
        while index < len(lines):
            if not lines[index].startswith('--- a/') or index + 1 >= len(lines) or not lines[index + 1].startswith('+++ b/'):
                raise ValueError('invalid patch file header')
            name = lines[index][6:].rstrip('\n')
            if lines[index + 1][6:].rstrip('\n') != name or name not in originals or name in changes:
                raise ValueError('unexpected patch path')
            index += 2
            start = index
            while index < len(lines) and not lines[index].startswith('--- a/'):
                index += 1
            changes[name] = apply_exact(originals[name], lines[start:index])
        if set(changes) != set(originals):
            raise ValueError('incomplete patch')
        output.mkdir(mode=0o700)
        tar.extractall(output, filter='data')
    for name, content in changes.items():
        target = output / name
        if target.is_symlink() or not target.is_file():
            raise ValueError('unsafe extracted source')
        target.write_text(content, encoding='utf-8')
    files = {}
    for target in sorted(output.rglob('*')):
        name = str(target.relative_to(output))
        if target.is_symlink():
            files[name] = {'symlink': str(target.readlink())}
        elif target.is_file():
            files[name] = {'sha256': sha256(target.read_bytes())}
    manifest = {'baseline': COMMIT, 'archiveSha256': sha256(archive), 'patchSha256': PATCH_SHA256, 'files': files}
    with (output / 'dsh-raw-export-manifest.json').open('x', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write('\n')
    print('archive_sha256=' + sha256(archive))
    print('patch_sha256=' + PATCH_SHA256)
    print('export_manifest_sha256=' + sha256((output / 'dsh-raw-export-manifest.json').read_bytes()))
    for name in sorted(changes):
        print(name + '=' + sha256(changes[name].encode('utf-8')))


if __name__ == '__main__':
    main()
