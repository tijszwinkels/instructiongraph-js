/**
 * Canonical refs of the six git-hosting TYPE objects (signed by `default`
 * AxyU5_… in realm server-public). Used as `type_def` relations on every
 * git object/ref we create. Kept in one place so there is a single source of
 * truth (and it is obvious what to change if the types are ever re-published).
 */

const DEFAULT = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ'

export const TYPE_REFS = {
  GIT_REPOSITORY: `${DEFAULT}.442843db-fc95-498e-b817-a92397a3d117`,
  GIT_COMMIT: `${DEFAULT}.5ed702f4-579d-412b-a4b8-1ec2537e12cb`,
  GIT_TREE: `${DEFAULT}.f91fdae4-2548-4b83-b512-13c7ca877d7a`,
  GIT_BLOB: `${DEFAULT}.a2d0d6cb-b0ac-449a-aaea-1bdeead2616f`,
  GIT_TAG: `${DEFAULT}.df3e5cbe-030c-4923-aba1-d64a0172add8`,
  GIT_REF: `${DEFAULT}.a711a32b-4090-4133-9aa2-83d3071d29ec`,
}

/** git object kind → ig TYPE name. */
export const OTYPE_TO_TYPE = {
  commit: 'GIT_COMMIT',
  tree: 'GIT_TREE',
  blob: 'GIT_BLOB',
  tag: 'GIT_TAG',
}
