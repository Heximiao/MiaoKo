import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const buildPattern = /^\d+\.\d+\.\d+-\d+$/;

async function digest(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

export async function inspectBuild(qqRoot, profileRoot) {
    const root = await realpath(resolve(qqRoot));
    const config = JSON.parse(await readFile(join(root, 'versions', 'config.json'), 'utf8'));
    const build = config.curVersion;
    if (typeof build !== 'string' || !buildPattern.test(build)) {
        throw new Error('Invalid QQ current build');
    }

    const result = await inspectLoadedModule(
        join(root, 'versions', build, 'resources', 'app', 'wrapper.node'),
        profileRoot,
    );
    if (result.build !== build) {
        throw new Error('QQ package does not match the selected Windows x64 build');
    }
    return result;
}

export async function inspectLoadedModule(modulePath, profileRoot) {
    const module = await realpath(resolve(modulePath));
    if (basename(module).toLowerCase() !== 'wrapper.node') {
        throw new Error('Expected a QQ wrapper.node module');
    }
    const manifest = JSON.parse(await readFile(join(dirname(module), 'package.json'), 'utf8'));
    const build = manifest.version;
    if (typeof build !== 'string' || !buildPattern.test(build) ||
        manifest.platform !== 'win32' || manifest.eleArch !== 'x64') {
        throw new Error('Expected a Windows x64 QQ package with a complete build number');
    }
    const sha256 = await digest(module);
    const identity = { build, architecture: manifest.eleArch, module, sha256 };
    const profileName = build + '-win-x64';
    try {
        const variant = join(profileRoot, profileName + '-' + sha256 + '.json');
        const contents = await readFile(variant, 'utf8').catch(error => {
            if (error.code !== 'ENOENT') throw error;
            return readFile(join(profileRoot, profileName + '.json'), 'utf8');
        });
        const profile = JSON.parse(contents);
        if (profile.build !== build || profile.architecture !== manifest.eleArch ||
            profile.module !== 'wrapper.node' || profile.sha256 !== sha256) {
            return { ...identity, status: 'fingerprint-mismatch' };
        }
        return { ...identity, status: 'known-build', receive: profile.receive,
            actions: profile.actions, duplexModule: profile.duplexModule };
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
        return { ...identity, status: 'unknown-build' };
    }
}
