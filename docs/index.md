# Canon

Canon is how this team plans, writes, reviews and publishes GEO blogs for clients. You pick a brand, tick the topics you want written, and the engine researches each one, drafts it, checks it against that brand's own facts and scores it. You read what comes back, decide what the client sees, and publish it.

Canon runs on your own computer: you start the app and it opens the dashboard in your browser. Writing a blog uses the Claude account that machine is signed into, so the work happens locally. The brands, articles and comments live in a shared database, so the six of you see the same work.

You sign in to Canon with your own account. There is no sign-up page: an admin creates accounts, and the same sign-in page serves your team and your clients.

!!! danger "Generating spends real money"
    Canon has no demo mode and no test mode. Every blog runs the full agent chain for real, against live sources, using the Claude Code login on the machine that runs it. A batch of roadmap rows can use a large share of a personal plan's quota, so start only the runs you mean to pay for.

## Start here

If you have never used Canon, read these three in order.

1. **[Installing Canon](getting-started/install.md)**: what you need before you start, and the one time you touch a terminal.
2. **[Starting Canon for the first time](getting-started/first-run.md)**: the two ways to launch it, the coloured dot, and signing in.
3. **[Your first blog, start to finish](guide/your-first-blog.md)**: one blog, from picking a brand to reading the finished article.

After that, [How a blog gets made](concepts/how-it-works.md) explains what the engine is doing while you wait, and [What each status means](concepts/blog-states.md) is the page you will keep coming back to.

## What is in this site

| Section | Read it if you |
| --- | --- |
| **Getting started** | are setting Canon up on your machine, or writing your first blog. |
| **How Canon works** | want to understand the pipeline, the way brands are organised, and what every status tag means. |
| **Using Canon** | are working day to day: roadmaps, the Blogs tab, reviewing, publishing, social channels, reports. |
| **The client portal** | need to know what your client sees, and what to tell them. |
| **Administration** | add brands, or watch the queue when several runs are in flight. |
| **Reference** | are stuck, or have a question that starts with "why does it". |

## Three things worth knowing on day one

**Everything is scoped to a brand.** There is no global blogs page and no global create page. A blog needs a brand to mean anything, because it needs that brand's facts and that brand's roadmap. See [Organisations and brands](concepts/organisations-and-brands.md).

**The engine scores every article and the bar is 90.** At 90 and above the blog is finished and waiting on your team. Below 90 it does not ship on its own, and you decide whether to rerun it or send it anyway. See [How a blog gets made](concepts/how-it-works.md).

**A blog can be held for a human answer at any score.** When the evaluator cannot tell whether a claim is true, it asks, and the article waits until somebody answers. A blog scoring 96 with an open question is still held. See [What each status means](concepts/blog-states.md).
