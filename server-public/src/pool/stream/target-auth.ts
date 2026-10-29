import { routeTarget } from "../../caveman/routes.ts";
import { resolveTargetReference, type TargetRegistry } from "../fallback/index.ts";
import type { ResolvedTargetAuth } from "./request-options.ts";

export interface TargetAuthRegistry<Model, Provider> extends TargetRegistry<Model, Provider> {
	getApiKeyAndHeaders(model: Model): Promise<ResolvedTargetAuth & { ok: boolean; error?: string }>;
}

export async function resolveAuthenticatedTarget<Model, Provider>(
	aliasId: string,
	targetRef: string,
	registry: TargetAuthRegistry<Model, Provider>,
): Promise<{ model: Model; provider: Provider; auth: ResolvedTargetAuth }> {
	const target = resolveTargetReference(aliasId, targetRef, registry);
	const auth = await registry.getApiKeyAndHeaders(target.model);
	if (!auth.ok) {
		throw new Error(`Model alias "${aliasId}" target "${targetRef}" is unavailable: ${auth.error}`);
	}
	// pangpang: send the target through the caveman proxy when routing is open.
	let oauth = true;
	try {
		oauth = (registry as unknown as { isUsingOAuth(m: Model): boolean }).isUsingOAuth(target.model);
	} catch {
		// Unknown auth kind: treat as OAuth and keep it direct.
	}
	const model = routeTarget(target.model, auth.headers as Record<string, unknown> | undefined, oauth);
	return { ...target, model, auth };
}
