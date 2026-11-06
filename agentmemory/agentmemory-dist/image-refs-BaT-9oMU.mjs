#!/usr/bin/env node
import { i as withKeyedLock, n as touchImage, r as KV, t as deleteImage } from "./index.mjs";
import { TriggerAction } from "iii-sdk";
//#region src/functions/image-refs.ts
async function getImageRefCount(kv, filePath) {
	const count = await kv.get(KV.imageRefs, filePath);
	return count ? Number(count) : 0;
}
async function incrementImageRef(kv, filePath) {
	return withKeyedLock(`imgRef:${filePath}`, async () => {
		const current = await getImageRefCount(kv, filePath);
		await kv.set(KV.imageRefs, filePath, current + 1);
		await touchImage(filePath);
	});
}
async function decrementImageRef(kv, sdk, filePath) {
	return withKeyedLock(`imgRef:${filePath}`, async () => {
		const current = await getImageRefCount(kv, filePath);
		if (current <= 1) {
			await kv.delete(KV.imageEmbeddings, filePath);
			await kv.delete(KV.imageRefs, filePath);
			const { deletedBytes } = await deleteImage(filePath);
			if (deletedBytes > 0) sdk.trigger({
				function_id: "mem::disk-size-delta",
				payload: { deltaBytes: -deletedBytes },
				action: TriggerAction.Void()
			});
		} else await kv.set(KV.imageRefs, filePath, current - 1);
	});
}
//#endregion
export { decrementImageRef, getImageRefCount, incrementImageRef };

//# sourceMappingURL=image-refs-BaT-9oMU.mjs.map