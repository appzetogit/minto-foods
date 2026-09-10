import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * These two rules are what make a Firebase project swap safe, so they are
 * tested against the real module rather than a copy.
 */

const dir = mkdtempSync(join(tmpdir(), 'fb-'));
const keyPath = join(dir, 'sa.json');
const writeKey = (projectId) =>
    writeFileSync(keyPath, JSON.stringify({
        project_id: projectId,
        client_email: 'x@y.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
    }));

// Loaded fresh per case: the module caches the service account.
const loadWith = async ({ keyProject, envProject }) => {
    writeKey(keyProject);
    process.env.FIREBASE_SERVICE_ACCOUNT = '';
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH = keyPath;
    if (envProject === undefined) delete process.env.FIREBASE_PROJECT_ID;
    else process.env.FIREBASE_PROJECT_ID = envProject;
    delete process.env.VITE_FIREBASE_PROJECT_ID;
    return import(`./firebase.service.js?case=${Math.random()}`);
};

test('sends from the project the service account belongs to', async () => {
    const m = await loadWith({ keyProject: 'mintofoods-8981a', envProject: undefined });
    assert.equal(m.getFirebaseProjectId(), 'mintofoods-8981a');
});

test('a matching FIREBASE_PROJECT_ID is fine', async () => {
    const m = await loadWith({ keyProject: 'mintofoods-8981a', envProject: 'mintofoods-8981a' });
    assert.equal(m.getFirebaseProjectId(), 'mintofoods-8981a');
});

test('a disagreeing FIREBASE_PROJECT_ID is fatal, not silently preferred', async () => {
    const m = await loadWith({ keyProject: 'mintofoods-8981a', envProject: 'minto-805bd' });
    assert.throws(() => m.getFirebaseProjectId(), /mismatch/i);
});

test('a wrong-project token is never deleted', async () => {
    const m = await loadWith({ keyProject: 'mintofoods-8981a', envProject: undefined });
    const err = { error: { message: 'The registration token is not a valid FCM registration token for this Sender ID.' } };
    assert.equal(m.shouldRemoveTokenFromError(err, { status: 400 }), false);
});

test('an unregistered device is still pruned', async () => {
    const m = await loadWith({ keyProject: 'mintofoods-8981a', envProject: undefined });
    assert.equal(
        m.shouldRemoveTokenFromError({ error: { message: 'UNREGISTERED' } }, { status: 404 }),
        true,
    );
});

test('a 404 is still pruned', async () => {
    const m = await loadWith({ keyProject: 'mintofoods-8981a', envProject: undefined });
    assert.equal(
        m.shouldRemoveTokenFromError({ error: { message: 'NOT_FOUND' } }, { status: 404 }),
        true,
    );
});
