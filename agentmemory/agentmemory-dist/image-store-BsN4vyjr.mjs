import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { mkdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
//#region src/utils/image-store.ts
const IMAGES_DIR = join(homedir(), ".agentmemory", "images");
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;
function getMaxBytes() {
	return Number(process.env.AGENTMEMORY_IMAGE_STORE_MAX_BYTES) || DEFAULT_MAX_BYTES;
}
function isManagedImagePath(filePath) {
	const resolved = resolve(filePath);
	const normalizedImagesDir = resolve(IMAGES_DIR);
	return resolved.startsWith(normalizedImagesDir + sep) || resolved === normalizedImagesDir;
}
function contentHash(data) {
	return createHash("sha256").update(data).digest("hex");
}
async function saveImageToDisk(base64Data) {
	if (!base64Data) return {
		filePath: "",
		bytesWritten: 0
	};
	if (!existsSync(IMAGES_DIR)) await mkdir(IMAGES_DIR, { recursive: true });
	let cleanBase64 = base64Data;
	let ext = "png";
	if (base64Data.startsWith("data:image/")) {
		const commaIdx = base64Data.indexOf(",");
		if (commaIdx !== -1) {
			const meta = base64Data.substring(0, commaIdx);
			if (meta.includes("jpeg") || meta.includes("jpg")) ext = "jpg";
			else if (meta.includes("webp")) ext = "webp";
			else if (meta.includes("gif")) ext = "gif";
			cleanBase64 = base64Data.substring(commaIdx + 1);
		}
	} else if (base64Data.startsWith("/9j/")) ext = "jpg";
	const filePath = join(IMAGES_DIR, `${contentHash(cleanBase64)}.${ext}`);
	if (existsSync(filePath)) return {
		filePath,
		bytesWritten: 0
	};
	await writeFile(filePath, Buffer.from(cleanBase64, "base64"));
	return {
		filePath,
		bytesWritten: (await stat(filePath)).size
	};
}
async function deleteImage(filePath) {
	if (!filePath) return { deletedBytes: 0 };
	if (!isManagedImagePath(filePath)) return { deletedBytes: 0 };
	try {
		if (existsSync(filePath)) {
			const size = (await stat(filePath)).size;
			await unlink(filePath);
			return { deletedBytes: size };
		}
	} catch (err) {
		console.error("[agentmemory] Failed to delete image context:", err);
	}
	return { deletedBytes: 0 };
}
/** Touch an image file to update its mtime (marking it as recently used for LRU eviction) */
async function touchImage(filePath) {
	if (!filePath || !isManagedImagePath(filePath)) return;
	try {
		if (existsSync(filePath)) {
			const now = /* @__PURE__ */ new Date();
			await utimes(filePath, now, now);
		}
	} catch (err) {}
}
//#endregion
export { saveImageToDisk as a, isManagedImagePath as i, deleteImage as n, touchImage as o, getMaxBytes as r, IMAGES_DIR as t };

//# sourceMappingURL=image-store-BsN4vyjr.mjs.map