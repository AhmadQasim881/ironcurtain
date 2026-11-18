/**
 * An in-memory container image store with tags, for image build identity
 * tests: a build creates a new image id under its tag, `tagImage` adds a
 * reference, labels belong to images (not tags), `removeImage` drops a tag.
 */
import { basename } from 'node:path';
import type { ContainerRuntime, DockerImageInfo, ImageBuildOptions } from '../../src/docker/types.js';

export interface RecordedBuild {
  readonly tag: string;
  readonly dockerfile: string;
  readonly labels: Record<string, string> | undefined;
  readonly buildArgs: Readonly<Record<string, string>> | undefined;
  readonly options: ImageBuildOptions | undefined;
}

/**
 * An image store with tags: a build creates a new image id under its tag,
 * `tagImage` adds a reference, labels belong to images (not tags).
 */
export function makeImageStore(
  options: {
    /** False: a runtime without `tagImage`. */
    readonly tagging?: boolean;
    /** `probeImageVersion` result for an image reference and command. */
    readonly probe?: (ref: string, command: readonly string[]) => string | undefined;
  } = {},
) {
  const tags = new Map<string, string>();
  const images = new Map<string, Record<string, string>>();
  /** Engine-reported details of seeded images (platform, registry digests). */
  const details = new Map<string, Pick<DockerImageInfo, 'architecture' | 'repoDigests'>>();
  const builds: RecordedBuild[] = [];
  const tagCalls: Array<readonly [string, string]> = [];
  let sequence = 0;
  const idOf = (ref: string): string | undefined => tags.get(ref) ?? (images.has(ref) ? ref : undefined);
  const runtime = {
    supportsImageSnapshots: true,
    async buildImage(
      tag: string,
      dockerfilePath: string,
      _context: string,
      labels?: Record<string, string>,
      buildArgs?: Readonly<Record<string, string>>,
      buildOptions?: ImageBuildOptions,
    ) {
      sequence++;
      const id = `sha256:${String(sequence).padStart(64, '0')}`;
      images.set(id, { ...labels });
      tags.set(tag, id);
      builds.push({ tag, dockerfile: basename(dockerfilePath), labels, buildArgs, options: buildOptions });
    },
    async getImageLabel(ref: string, label: string) {
      const id = idOf(ref);
      return id === undefined ? undefined : images.get(id)?.[label];
    },
    async inspectImage(ref: string): Promise<DockerImageInfo | undefined> {
      const id = idOf(ref);
      if (id === undefined) return undefined;
      return {
        id,
        repoTags: [...tags].filter(([, target]) => target === id).map(([tag]) => tag),
        labels: images.get(id) ?? {},
        created: '',
        ...details.get(id),
      };
    },
    async listImages(): Promise<readonly DockerImageInfo[]> {
      return [...images.keys()].map((id) => ({
        id,
        repoTags: [...tags].filter(([, target]) => target === id).map(([tag]) => tag),
        labels: images.get(id) ?? {},
        created: '2026-11-01T00:00:00Z',
        ...details.get(id),
      }));
    },
    async removeImage(ref: string) {
      return tags.delete(ref);
    },
    ...(options.probe === undefined
      ? {}
      : {
          async probeImageVersion(ref: string, command: readonly string[]) {
            return options.probe?.(ref, command);
          },
        }),
    ...(options.tagging === false
      ? {}
      : {
          async tagImage(source: string, target: string) {
            tagCalls.push([source, target]);
            const id = idOf(source);
            if (id === undefined) throw new Error(`no such image: ${source}`);
            tags.set(target, id);
          },
        }),
  } as unknown as ContainerRuntime;
  /**
   * Seeds an image under `tag` (as an older IronCurtain or another checkout
   * left it, or a pulled image with its platform and registry digests).
   */
  const seed = (
    tag: string,
    labels: Record<string, string>,
    info: Pick<DockerImageInfo, 'architecture' | 'repoDigests'> = {},
  ): string => {
    sequence++;
    const id = `sha256:${String(sequence).padStart(64, '0')}`;
    images.set(id, labels);
    details.set(id, info);
    tags.set(tag, id);
    return id;
  };
  return { runtime, builds, tags, tagCalls, seed, idOf };
}
