export class ActionError extends Error {
    constructor(retcode, message) {
        super(message);
        this.retcode = retcode;
    }
}

export function booleanParam(value, name) {
    if (value === true || value === 'true' || value === '1') return true;
    if (value === false || value === 'false' || value === '0') return false;
    throw new ActionError(1400, name + ' must be a boolean');
}

export function qqId(value, name) {
    if ((typeof value !== 'string' && !Number.isSafeInteger(value)) ||
        !/^[1-9]\d{4,11}$/.test(String(value))) {
        throw new ActionError(1400, 'Invalid ' + name);
    }
    return String(value);
}
