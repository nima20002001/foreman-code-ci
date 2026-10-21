import { z } from 'zod'
/** Filename validation shared by document uploads and the separate CI output class. */
export const FileNameSchema = z.string().trim().min(1).max(255)
  .refine((name) => name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
    && !Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    'Use a filename, not a path or control characters')
