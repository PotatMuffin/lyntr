import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { verifyAuthJWT } from '@/server/jwt';
import { minioClient } from '@/server/minio';
import { v4 as uuidv4 } from 'uuid';
import { config } from 'dotenv';
import { uploadAvatar } from '../util';

config();

export const POST: RequestHandler = async ({ request, cookies }) => {
    const authCookie = cookies.get('_TOKEN__DO_NOT_SHARE');

    if (!authCookie) {
        return json({ error: 'Missing authentication' }, { status: 401 });
    }

    try {
        const jwtPayload = await verifyAuthJWT(authCookie);

        if (!jwtPayload.userId) {
            throw new Error('Invalid JWT token');
        }


        const formData = await request.formData();

        const file = formData.get('file') as File;

        if (!file) {
            return json({ error: 'No file uploaded' }, { status: 400 });
        }

        const fileName = jwtPayload.userId;

        const arrayBuffer = await file.arrayBuffer();
        const inputBuffer = Buffer.from(arrayBuffer);

        // compression
        uploadAvatar(inputBuffer, fileName, minioClient)

        return json({
            message: 'File uploaded successfully',
        }, { status: 200 });

    } catch (error) {
        console.error('File upload error:', error);
        return json({ error: 'File upload failed' }, { status: 500 });
    }
};