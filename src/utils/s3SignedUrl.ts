import { GetObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { s3 } from "../services/s3Storage";

export const getSignedFileUrl = async (key: string) => {

  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key
  })

  return await getSignedUrl(s3, command, {
    expiresIn: 3600
  })
}