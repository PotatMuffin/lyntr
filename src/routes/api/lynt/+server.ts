import { json } from '@sveltejs/kit';
import type { Cookies, RequestHandler } from '@sveltejs/kit';
import { verifyAuthJWT } from '@/server/jwt';
import { db } from '@/server/db';
import { likes, lynts, users } from '@/server/schema';
import { eq, sql, and } from 'drizzle-orm';
import sanitizeHtml from 'sanitize-html';
import { Snowflake } from 'nodejs-snowflake';
import sharp from 'sharp';
import { minioClient } from '@/server/minio';
import { lyntObj } from '../util';

export const POST: RequestHandler = async ({ request, cookies }: { request: Request, cookies: Cookies }) => {
    const authCookie = cookies.get('_TOKEN__DO_NOT_SHARE');

    if (!authCookie) {
        return json({ error: 'Missing authentication' }, { status: 401 });
    }

    let userId: string;

    try {
        const jwtPayload = await verifyAuthJWT(authCookie);
        userId = jwtPayload.userId;

        if (!userId) {
            throw new Error('Invalid JWT token');
        }
    } catch (error) {
        console.error('Authentication error:', error);
        return json({ error: 'Authentication failed' }, { status: 401 });
    }

    const formData = await request.formData();

    let content = formData.get('content') as string;
    const imageFile = formData.get('image') as File | null;
    const reposted = formData.get('reposted') as string;

    if (!content) content = ''

    if (content.length > 280) {
        return json({ error: 'Invalid content' }, { status: 400 });
    }

    let cleanedContent = sanitizeHtml(content);

    try {
        const lyntId = new Snowflake({
            custom_epoch: new Date("2024-07-13T11:29:44.526Z").getTime(),
        });

        const uniqueLyntId = String(lyntId.getUniqueID());

        let lyntValues: any = {
            id: uniqueLyntId,
            user_id: userId,
            content: cleanedContent,
            has_link: cleanedContent.includes('http'),
        };
        console.log(reposted)
        if (reposted) {
            const [existingLynt] = await db
                .select({ id: lynts.id })
                .from(lynts)
                .where(eq(lynts.id, reposted))
                .limit(1);

            if (existingLynt) {
                lyntValues.reposted = true;
                lyntValues.parent = reposted;
            } else {
                return json({ error: 'Invalid reposted lynt ID' }, { status: 400 });
            }
        }

        if (imageFile) {
            const buffer = await imageFile.arrayBuffer();
            const inputBuffer = Buffer.from(buffer);

            const resizedBuffer = await sharp(inputBuffer)
                .resize({
                    fit: sharp.fit.contain,
                    width: 800
                })
                .webp({ quality: 50 })
                .toBuffer();

            const fileName = `${uniqueLyntId}.webp`;

            await minioClient.putObject(process.env.S3_BUCKET_NAME!, fileName, resizedBuffer, resizedBuffer.length, {
                'Content-Type': 'image/webp',
            });

            lyntValues.has_image = true
        }

        const [newLynt] = await db.insert(lynts).values(lyntValues).returning();

        return json(newLynt, { status: 201 });
    } catch (error) {
        console.error('Error creating lynt:', error);
        return json({ error: 'Failed to create lynt' }, { status: 500 });
    }
};

export const GET: RequestHandler = async ({ url, request, cookies }: { url: URL, request: Request, cookies: Cookies }) => {
    const authCookie = cookies.get('_TOKEN__DO_NOT_SHARE');

    if (!authCookie) {
        return json({ error: 'Missing authentication' }, { status: 401 });
    }

    let userId: string;

    try {
        const jwtPayload = await verifyAuthJWT(authCookie);

        userId = jwtPayload.userId

        if (!userId) {
            throw new Error('Invalid JWT token');
        }
    } catch (error) {
        console.error('Authentication error:', error);
        return json({ error: 'Authentication failed' }, { status: 401 });
    }

    const lyntId = url.searchParams.get('id');

    if (!lyntId) {
        return json({ error: 'Missing lynt ID' }, { status: 400 });
    }

    try {
        const lyntobj = lyntObj(userId)

        const [lynt] = await db
            .select({ ...lyntobj, parent: lynts.parent })
            .from(lynts)
            .leftJoin(users, eq(lynts.user_id, users.id))
            .where(eq(lynts.id, lyntId))
            .limit(1);

        if (!lynt) {
            return json({ error: 'Lynt not found' }, { status: 404 });
        }

        await db.execute(sql`UPDATE ${lynts} SET views = views + 1 WHERE id = ${lyntId}`);

        const referencedLynts = await fetchReferencedLynts(userId, lynt.parent);

        return json({ ...lynt, referencedLynts });
    } catch (error) {
        console.error('Error fetching lynt:', error);
        return json({ error: 'Failed to fetch lynt' }, { status: 500 });
    }
};

async function fetchReferencedLynts(userId: string, parentId: string | null): Promise<any[]> {
    const referencedLynts: any[] = [];

    async function fetchParent(currentParentId: string) {
        const obj = lyntObj(userId);

        const [parent] = await db
            .select(obj)
            .from(lynts)
            .leftJoin(users, eq(lynts.user_id, users.id))
            .where(
                and(
                    eq(lynts.id, currentParentId),
                    eq(lynts.reposted, false)
                )
            )
            .limit(1);

        if (parent) {
            referencedLynts.unshift(parent); // Add to the beginning of the array
            if (parent.parentId) {
                await fetchParent(parent.parentId);
            }
        }
    }

    if (parentId) {
        await fetchParent(parentId);
    }

    return referencedLynts;
}