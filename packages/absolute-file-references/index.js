/**
 * dsh-absolute-file-references — host half.
 *
 * This bundle is a CLIENT-side input tweak: the `@` picker's onPick result is
 * rewritten in the browser, so there is nothing to mount on the host. `apply`
 * exists only so the package has the same shape as every other bundle in the
 * workbench (the suite mounts each host half in turn).
 */
export const name = 'dsh-absolute-file-references'

export function apply() {}
