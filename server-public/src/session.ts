// Session construction shared by chats and the background reviewer.
//
// An SDK host must bind extensions itself; that is what emits session_start
// (pi's print and rpc modes do the same).  Extensions that keep per-session
// state, such as the model pool, depend on it.
//
// pi resolves the default model before extensions are bound, so a model
// that an extension provides (the pool's alias/main) is not found and pi
// falls back to another provider; an existing session also restores
// whatever model it last used.  After the session is created, and the pool
// has registered its provider on the same ModelRuntime, apply the configured
// default explicitly.

import {
	type AgentSession,
	createAgentSession,
	type CreateAgentSessionOptions,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { AGENT_DIR } from "./config.ts";
import { errorText, log } from "./log.ts";

export async function createSession(
	options: Omit<CreateAgentSessionOptions, "agentDir" | "modelRuntime" | "settingsManager"> & { cwd: string },
): Promise<AgentSession> {
	const modelRuntime = await ModelRuntime.create({
		authPath: join(AGENT_DIR, "auth.json"),
		modelsPath: join(AGENT_DIR, "models.json"),
	});
	const settingsManager = SettingsManager.create(options.cwd, AGENT_DIR);
	const { session } = await createAgentSession({ ...options, agentDir: AGENT_DIR, modelRuntime, settingsManager });
	await session.bindExtensions({
		mode: "print",
		onError: (err) => log.warn("extension", errorText(err)),
	});

	const provider = settingsManager.getDefaultProvider();
	const id = settingsManager.getDefaultModel();
	if (provider && id) {
		const wanted = modelRuntime.getModel(provider, id);
		const current = session.model as { provider?: string; id?: string } | undefined;
		if (!wanted) {
			log.warn("session", `default model ${provider}/${id} is not available`);
		} else if (current?.provider !== provider || current?.id !== id) {
			await session.setModel(wanted).catch((err) => log.warn("session", `cannot select ${provider}/${id}`, errorText(err)));
		}
	}
	return session;
}
