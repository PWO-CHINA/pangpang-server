// Agent-maintained skill library, internalized from Hermes Agent's
// skill_manage tool (MIT, Nous Research).
//
// The library is agent/skills/, private and ignored by Git by default. pi
// discovers the directory and lists skills in the system prompt; the agent
// reads a SKILL.md with the read tool when it decides to use a skill.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { paths } from "./config.ts";

export type SkillAction = "create" | "patch" | "write_file" | "delete";

export interface SkillRequest {
	action: SkillAction;
	name: string;
	content?: string;
	old_text?: string;
	new_text?: string;
	file_path?: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUPPORT_DIRS = ["references/", "templates/", "scripts/"];

function frontmatterProblem(content: string, name: string): string | undefined {
	const match = content.match(/^---\n([\s\S]*?)\n---\n/);
	if (!match) return "SKILL.md must start with YAML frontmatter (---\\nname: ...\\ndescription: ...\\n---)";
	const fm = match[1];
	const fmName = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
	if (fmName !== name) return `frontmatter name must be "${name}"`;
	if (!/^description:\s*\S/m.test(fm)) return "frontmatter needs a non-empty description";
	return undefined;
}

export function manageSkill(req: SkillRequest): { success: boolean; message: string } {
	const fail = (message: string) => ({ success: false, message });
	if (!NAME.test(req.name ?? "")) return fail("name must be lowercase letters, digits and dashes");

	const dir = join(paths.skills, req.name);
	const skillFile = join(dir, "SKILL.md");

	switch (req.action) {
		case "create": {
			if (existsSync(skillFile)) return fail(`skill "${req.name}" exists; use patch to change it`);
			const content = req.content ?? "";
			const problem = frontmatterProblem(content, req.name);
			if (problem) return fail(problem);
			mkdirSync(dir, { recursive: true });
			writeFileSync(skillFile, content.endsWith("\n") ? content : `${content}\n`);
			return { success: true, message: `created ${relative(paths.skills, skillFile)}` };
		}
		case "patch": {
			if (!existsSync(skillFile)) return fail(`no skill "${req.name}"; use create`);
			const current = readFileSync(skillFile, "utf8");
			const oldText = req.old_text ?? "";
			if (!oldText) return fail("old_text is required for patch");
			const count = current.split(oldText).length - 1;
			if (count === 0) return fail("old_text not found; read the SKILL.md again and copy the exact text");
			if (count > 1) return fail(`old_text occurs ${count} times; include more context`);
			const next = current.replace(oldText, req.new_text ?? "");
			const problem = frontmatterProblem(next, req.name);
			if (problem) return fail(`patch would break SKILL.md: ${problem}`);
			writeFileSync(skillFile, next);
			return { success: true, message: `patched ${relative(paths.skills, skillFile)}` };
		}
		case "write_file": {
			if (!existsSync(skillFile)) return fail(`no skill "${req.name}"; create it first`);
			const rel = normalize(req.file_path ?? "").replaceAll("\\", "/");
			if (!SUPPORT_DIRS.some((d) => rel.startsWith(d)) || rel.includes("..")) {
				return fail(`file_path must be under ${SUPPORT_DIRS.join(", ")}`);
			}
			const target = join(dir, rel);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, req.content ?? "");
			return {
				success: true,
				message: `wrote ${relative(paths.skills, target)}; add a one-line pointer to it in SKILL.md`,
			};
		}
		case "delete": {
			if (!existsSync(dir)) return fail(`no skill "${req.name}"`);
			rmSync(dir, { recursive: true, force: true });
			return { success: true, message: `deleted skill "${req.name}"` };
		}
		default:
			return fail(`unknown action ${JSON.stringify(req.action)}`);
	}
}
