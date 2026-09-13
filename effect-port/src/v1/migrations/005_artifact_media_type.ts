export const artifactMediaTypeSql = `
ALTER TABLE artifacts ADD COLUMN media_type TEXT NOT NULL DEFAULT 'application/octet-stream';
`;
