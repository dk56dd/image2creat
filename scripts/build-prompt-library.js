const fs = require("node:fs/promises");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const sourcePath = path.join(rootDir, "prompt-source.md");
const outputPath = path.join(rootDir, "public", "prompts.json");
const sourceUrl = "https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/main/README.md";
const imageBase = "https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/main/images/";

const tagRules = new Map([
  ["ui", ["ui", "interface", "app", "dashboard", "screen", "界面", "应用", "网页", "wireframe"]],
  ["photo", ["photo", "photography", "camera", "portrait photo", "street photography", "摄影", "照片", "realistic"]],
  ["poster", ["poster", "海报", "flyer", "campaign", "advertisement", "ad design"]],
  ["portrait", ["portrait", "headshot", "人像", "肖像", "model", "face"]],
  ["illustration", ["illustration", "watercolor", "sketch", "插画", "illustrated", "gouache", "ink wash"]],
  ["anime", ["anime", "manga", "二次元", "ghibli", "kawaii", "chibi"]],
  ["product", ["product", "e-commerce", "ecommerce", "packaging", "bottle", "cosmetic", "产品", "电商", "main image"]],
  ["3d", ["3d", "render", "octane", "blender", "isometric", "clay", "渲染"]],
  ["landscape", ["landscape", "city", "urban", "travel", "风景", "城市", "architecture", "panorama"]],
  ["character", ["character", "character sheet", "角色", "设定", "turnaround", "mascot"]],
  ["logo", ["logo", "brand mark", "identity", "标志", "品牌", "logotype"]],
  ["fashion", ["fashion", "outfit", "clothing", "服装", "时尚", "editorial fashion"]],
  ["cyberpunk", ["cyberpunk", "neon", "赛博", "sci-fi", "futuristic"]],
  ["infographic", ["infographic", "diagram", "chart", "图鉴", "信息图", "encyclopedia"]],
  ["food", ["food", "restaurant", "recipe", "美食", "cooking", "drink", "beverage"]]
]);

function tagsFor(title, prompt) {
  const haystack = `${title} ${prompt}`.toLowerCase();
  const tags = [];
  for (const [tag, keywords] of tagRules.entries()) {
    if (keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
      tags.push(tag);
    }
  }
  if (!tags.length) tags.push("other");
  return tags.slice(0, 3);
}

function parsePrompts(markdown) {
  const items = [];
  const casePattern = /###\s+Case\s+\d+:\s*\[([^\]]+)\]\(([^)]*)\)\s*\(by\s*\[@?([^\])\s]+)[^\)]*\)/g;
  const cases = [...markdown.matchAll(casePattern)];

  for (let index = 0; index < cases.length; index += 1) {
    const match = cases[index];
    const title = match[1].trim();
    const link = match[2].trim();
    const author = match[3].trim().replace(/^@/, "");
    const start = match.index + match[0].length;
    const end = index + 1 < cases.length ? cases[index + 1].index : markdown.length;
    const block = markdown.slice(start, end);
    const imageMatch = block.match(/<img\s+src="\.\/images\/([^"]+)"/);
    const promptMatch = block.match(/\*\*Prompt:\*\*\s*\n\s*```[^\n]*\n([\s\S]*?)```/);
    if (!imageMatch || !promptMatch) continue;

    let prompt = promptMatch[1].trim();
    if (prompt.length > 1600) prompt = `${prompt.slice(0, 1600)}...`;
    items.push({
      id: items.length + 1,
      title,
      prompt,
      image: `${imageBase}${imageMatch[1]}`,
      tags: tagsFor(title, prompt),
      author: `@${author}`,
      source: "EvoLinkAI",
      sourceUrl: link || "https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts"
    });
  }

  return items;
}

async function main() {
  let markdown;
  try {
    markdown = await fs.readFile(sourcePath, "utf8");
  } catch {
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`Failed to fetch prompt source: ${response.status}`);
    markdown = await response.text();
  }
  const prompts = parsePrompts(markdown);
  if (!prompts.length) throw new Error("No prompts parsed");
  await fs.writeFile(outputPath, `${JSON.stringify({ prompts }, null, 2)}\n`, "utf8");
  console.log(`wrote ${prompts.length} prompts to ${path.relative(rootDir, outputPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
