import batchedFunction from 'batched-function';
import React from 'dom-chef';
import * as pageDetect from 'github-url-detection';
import {$optional, closestElement, elementExists} from 'select-dom';

import {withTooltipRef} from '../components/tooltip.js';
import features from '../feature-manager.js';
import api from '../github-helpers/api.js';
import observe from '../helpers/selector-observer.js';

type Changes = {
	additions: number;
	deletions: number;
};

function render(link: HTMLAnchorElement, {additions, deletions}: Changes): void {
	const row = closestElement(['.js-issue-row', 'li'], link);
	if (elementExists('.rgh-pr-list-lines-changed', row)) {
		return;
	}

	const metadata = $optional([
		'div[class*="description"]', // React PR lists
		'.text-small.color-fg-muted', // Legacy PR lists
	], row);
	if (!metadata) {
		return;
	}

	metadata.append(
		<span
			className="rgh-pr-list-lines-changed ml-2 tmp-ml-2 text-small text-mono"
			style={{whiteSpace: 'nowrap'}}
			ref={withTooltipRef(`${additions} lines added, ${deletions} lines deleted`)}
		>
			<span className="color-fg-success">+{additions}</span> <span className="color-fg-danger">−{deletions}</span>
		</span>,
	);
}

async function add(links: HTMLAnchorElement[], signal: AbortSignal): Promise<void> {
	type PullRequest = {
		owner: string;
		repo: string;
		number: number;
		links: HTMLAnchorElement[];
	};

	if (signal.aborted) {
		return;
	}

	const prs = new Map<string, PullRequest>();
	for (const link of links) {
		if (!link.isConnected) {
			continue;
		}

		const [, owner, repo, , number] = link.pathname.split('/', 5);
		const key = `${owner}/${repo}/${number}`;
		const pr = prs.get(key);
		if (pr) {
			pr.links.push(link);
		} else {
			prs.set(key, {owner, repo, number: Number(number), links: [link]});
		}
	}

	if (prs.size === 0) {
		return;
	}

	const repos = [...Map.groupBy(prs.values(), pr => `${pr.owner}/${pr.repo}`).values()];
	const query = repos.map((repoPrs, index) => {
		const {owner, repo} = repoPrs[0];
		return `
			${api.escapeKey(index)}: repository(owner: "${owner}", name: "${repo}") {
				${
					repoPrs.map(pr => `
					${api.escapeKey(pr.number)}: pullRequest(number: ${pr.number}) {
						additions
						deletions
					}
				`).join('\n')
				}
			}
		`;
	}).join('\n');
	const data = await api.v4(query, {allowErrors: true});
	if (signal.aborted) {
		return;
	}

	for (const [index, repoPrs] of repos.entries()) {
		for (const pr of repoPrs) {
			// Repositories outside the token's permissions can be null in partial responses.
			const changes: Changes | undefined = data[api.escapeKey(index)]?.[api.escapeKey(pr.number)];
			if (!changes || typeof changes.additions !== 'number' || typeof changes.deletions !== 'number') {
				continue;
			}

			for (const link of pr.links) {
				if (link.isConnected && link.pathname === `/${pr.owner}/${pr.repo}/pull/${pr.number}`) {
					render(link, changes);
				}
			}
		}
	}
}

function init(signal: AbortSignal): void {
	observe(
		[
			'.js-issue-row a[data-hovercard-type="pull_request"]',
			'li[class*="listItem"] [class*="heading"] > a[class*="anchor"][href*="/pull/"]',
		],
		batchedFunction(async (links: HTMLAnchorElement[]) => add(links, signal), {delay: 100}),
		{signal},
	);
}

void features.add(import.meta.url, {
	include: [
		pageDetect.isPRList,
	],
	requiresToken: true,
	init,
});

/*

Test URLs:

https://github.com/refined-github/refined-github/pulls
https://github.com/refined-github/refined-github/pulls?q=is%3Apr+is%3Aclosed
https://github.com/pulls

*/
