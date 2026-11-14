import { fileURLToPath } from 'node:url';
import { inspectBuild, inspectLoadedModule } from './build.mjs';

const [input, modulePath, ...extra] = process.argv.slice(2);
const profiles = fileURLToPath(new URL('../../compat/', import.meta.url));

try {
    const inspectModule = input === '--loaded-module';
    if (extra.length || inspectModule !== Boolean(modulePath)) {
        throw new Error('Usage: inspect-build.mjs [QQ directory | --loaded-module path]');
    }
    const result = inspectModule
        ? await inspectLoadedModule(modulePath, profiles)
        : await inspectBuild(input ?? fileURLToPath(new URL('../../qq/', import.meta.url)), profiles);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'known-build') process.exitCode = 1;
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
