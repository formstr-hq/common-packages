export interface FileUploadMetadata {
  sha256: string;
  filename: string;
  size: number;
  mimeType: string;
  server: string;
  uploadedAt: number;
  uploaderPubkey: string;
}

export interface UploadParams {
  fileBytes: Uint8Array;
  filename: string;
  mimeType: string;
  formAuthorPubkey: string;
  responderSecretKey: Uint8Array;
  blossomServer: string;
}

export interface UploadResult {
  metadata: FileUploadMetadata;
}

export interface DownloadParams {
  metadata: FileUploadMetadata;
  formEditKey: string;
  uploaderPubkey: string;
}

export type AuthVerb = "upload" | "get" | "delete";
