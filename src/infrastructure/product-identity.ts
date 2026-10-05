import packageManifest from '../../package.json' with { type: 'json' };

export const productVersion: string = packageManifest.version;
