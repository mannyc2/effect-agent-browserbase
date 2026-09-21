import type { SessionReference } from "../../References.ts";
import type { UploadReceipt } from "../../Transfers.ts";

export interface IssuedUpload {
  readonly reference: SessionReference;
  readonly remotePath: string;
}

/**
 * Attachment authority belongs to the receipt this package actually issued, not to a value
 * that merely has the right shape. A fabricated look-alike has no entry here, so no caller
 * and no model can turn an arbitrary server pathname into an attached file.
 */
const issued = new WeakMap<UploadReceipt, IssuedUpload>();

export const recordIssuedUpload = (receipt: UploadReceipt, upload: IssuedUpload): void => {
  issued.set(receipt, Object.freeze({ ...upload }));
};

export const issuedUpload = (receipt: UploadReceipt): IssuedUpload | undefined =>
  issued.get(receipt);
