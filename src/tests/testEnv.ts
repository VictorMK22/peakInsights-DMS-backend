// Imported for side effects, before `app` (or anything that
// transitively imports it) in every test file. ts-jest compiles to
// CommonJS, so `require` — and therefore these assignments — run in
// the order the imports are written, meaning this genuinely runs
// before app.ts is evaluated as long as it's the first import.
process.env.JWT_SECRET ??= "test-jwt-secret-do-not-use-in-prod";
process.env.JWT_EXPIRES_IN ??= "1d";
process.env.FRONTEND_URL ??= "http://localhost:5173";
process.env.AWS_REGION ??= "us-east-1";
process.env.S3_ACCESS_KEY ??= "test-access-key";
process.env.AWS_SECRET_KEY ??= "test-secret-key";
process.env.S3_BUCKET ??= "test-bucket";
