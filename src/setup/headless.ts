/**
 * Non-interactive first-run setup.
 *
 * Used on hosts without a TTY (e.g. Railway). Reads the identity from
 * AUTOMATON_* environment variables, writes the same files as the wizard,
 * and applies a locked-down financial policy. Secrets are never logged.
 */

import fs from "fs";
import path from "path";
import type { AutomatonConfig, TreasuryPolicy } from "../types.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import { provision } from "../identity/provision.js";
import { getWallet, getAutomatonDir } from "../identity/wallet.js";
import { createConfig, saveConfig } from "../config.js";
import { writeDefaultHeartbeatConfig } from "../heartbeat/config.js";
import { detectEnvironment } from "./environment.js";
import { generateSoulMd, installDefaultSkills } from "./defaults.js";
import { isValidAddress, type ChainType } from "../identity/chain.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("setup.headless");

/** True when the AUTOMATON_* variables needed for headless setup are present. */
export function hasHeadlessEnv(): boolean {
  return !!process.env.AUTOMATON_NAME?.trim();
}

/** Conservative limits: no transfers, small x402 and inference budgets. */
export const HEADLESS_TREASURY_POLICY: TreasuryPolicy = {
  ...DEFAULT_TREASURY_POLICY,
  maxSingleTransferCents: 0,
  maxHourlyTransferCents: 0,
  maxDailyTransferCents: 0,
  maxTransfersPerTurn: 0,
  maxX402PaymentCents: 10,
  maxInferenceDailyCents: 500,
  requireConfirmationAboveCents: 1,
};

function fail(message: string): never {
  throw new Error(`Headless setup: ${message}`);
}

export async function runHeadlessSetup(): Promise<AutomatonConfig> {
  const env = process.env;

  const name = env.AUTOMATON_NAME?.trim();
  if (!name) fail("AUTOMATON_NAME is required");

  const genesisPrompt = env.AUTOMATON_GENESIS_PROMPT?.trim();
  if (!genesisPrompt) fail("AUTOMATON_GENESIS_PROMPT is required");

  const chainRaw = (env.AUTOMATON_CHAIN || "evm").trim().toLowerCase();
  if (chainRaw !== "evm" && chainRaw !== "solana") {
    fail(`AUTOMATON_CHAIN must be "evm" or "solana", got "${chainRaw}"`);
  }
  const chain = chainRaw as ChainType;

  const creatorAddress = env.AUTOMATON_CREATOR_ADDRESS?.trim();
  if (!creatorAddress || !isValidAddress(creatorAddress, chain)) {
    fail(`AUTOMATON_CREATOR_ADDRESS is missing or not a valid ${chain} address`);
  }

  const conwayKey = env.CONWAY_API_KEY?.trim() || "";
  const openaiApiKey = env.OPENAI_API_KEY?.trim() || undefined;
  const anthropicApiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  if (!conwayKey && !openaiApiKey && !anthropicApiKey) {
    fail("set at least one of CONWAY_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY");
  }

  const maxChildrenRaw = env.AUTOMATON_MAX_CHILDREN?.trim();
  const maxChildren = maxChildrenRaw === undefined || maxChildrenRaw === "" ? 0 : Number(maxChildrenRaw);
  if (!Number.isInteger(maxChildren) || maxChildren < 0) {
    fail("AUTOMATON_MAX_CHILDREN must be a non-negative integer");
  }

  logger.info(`Creating config for "${name}" (${chain})`);

  const { chainIdentity, chainType: walletChainType } = await getWallet(chain);
  const walletAddress = chainIdentity.address;
  logger.info(`Wallet address: ${walletAddress}`);

  // The runtime needs a Conway API key (credits, sandbox). Provision one via
  // SIWE/SIWS with the new wallet unless CONWAY_API_KEY was supplied.
  let apiKey = conwayKey;
  if (!apiKey) {
    try {
      const result = await provision(undefined, walletChainType === "solana" ? chainIdentity : undefined);
      apiKey = result.apiKey;
      logger.info(`Conway API key provisioned: ${result.keyPrefix}...`);
    } catch (err: any) {
      fail(`could not provision a Conway API key (${err.message}). Set CONWAY_API_KEY.`);
    }
  }

  const detected = detectEnvironment();

  const config = createConfig({
    name,
    genesisPrompt,
    creatorAddress,
    registeredWithConway: !!apiKey,
    sandboxId: detected.sandboxId,
    walletAddress,
    apiKey,
    openaiApiKey,
    anthropicApiKey,
    ollamaBaseUrl: env.OLLAMA_BASE_URL?.trim() || undefined,
    treasuryPolicy: { ...HEADLESS_TREASURY_POLICY },
    chainType: walletChainType,
  });
  config.maxChildren = maxChildren;
  config.soulConfig = {
    soulAlignmentThreshold: 0.5,
    enableSoulReflection: true,
    requireCreatorApprovalForPurposeChange: true,
  };

  saveConfig(config);
  writeDefaultHeartbeatConfig();

  const dir = getAutomatonDir();
  const constitutionSrc = path.join(process.cwd(), "constitution.md");
  const constitutionDst = path.join(dir, "constitution.md");
  if (fs.existsSync(constitutionSrc)) {
    if (fs.existsSync(constitutionDst)) fs.chmodSync(constitutionDst, 0o644);
    fs.copyFileSync(constitutionSrc, constitutionDst);
    fs.chmodSync(constitutionDst, 0o444);
  }

  fs.writeFileSync(
    path.join(dir, "SOUL.md"),
    generateSoulMd(name, walletAddress, creatorAddress, genesisPrompt),
    { mode: 0o600 },
  );
  installDefaultSkills(config.skillsDir || "~/.automaton/skills");

  logger.info("Headless setup complete. Fund the wallet above to start spending credits.");
  return config;
}
