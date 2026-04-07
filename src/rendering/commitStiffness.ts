/**
 * Module-level stiffness for new thread commits (0 = soft, 1 = stiff).
 * CreatePage writes here in slider/texture handlers; LoomCanvas syncs from softness prop each render.
 * WrapController reads at commit time when useCommitStiffnessFromModule is true.
 */
export const commitStiffness = { current: 0.6 };
