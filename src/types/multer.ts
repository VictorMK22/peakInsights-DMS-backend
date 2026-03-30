export interface S3File extends Express.Multer.File {
    key: string;
    location: string;
  }