/**
 * Gas for approve (~46k) + pool deposit (~310k on an empty tree, ~25k more per tree level), with
 * room for a tree of a million notes. Used for the payer's gas stipend and the shield cost check.
 */
export const SHIELD_GAS_BUDGET = 900_000n;
