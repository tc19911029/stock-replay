'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from 'next/link';

interface LearnContentProps {
  content: string;
}

export function LearnContent({ content }: LearnContentProps) {
  return (
    <article className="prose prose-invert prose-slate max-w-none
      prose-headings:font-bold
      prose-h1:text-2xl prose-h1:border-b prose-h1:border-border prose-h1:pb-3 prose-h1:mb-6
      prose-h2:text-xl prose-h2:mt-10 prose-h2:mb-4
      prose-h3:text-lg prose-h3:mt-8 prose-h3:mb-3
      prose-p:text-foreground/80 prose-p:leading-relaxed
      prose-li:text-foreground/80
      prose-strong:text-foreground
      prose-code:text-emerald-400 prose-code:bg-secondary prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:before:content-none prose-code:after:content-none
      prose-pre:bg-card prose-pre:border prose-pre:border-border prose-pre:rounded-lg
      prose-blockquote:border-l-blue-500 prose-blockquote:bg-blue-500/5 prose-blockquote:py-1 prose-blockquote:px-4 prose-blockquote:rounded-r-lg
      prose-table:text-sm
      prose-th:text-foreground prose-th:bg-secondary/50 prose-th:px-3 prose-th:py-2
      prose-td:px-3 prose-td:py-2 prose-td:border-border
      prose-hr:border-border
      prose-a:text-blue-400 prose-a:no-underline hover:prose-a:text-blue-300
    ">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Internal links (relative .md files) → Next.js Link
          a: ({ href, children, ...props }) => {
            if (href && href.endsWith('.md') && !href.startsWith('http')) {
              const slug = href.replace('.md', '').replace(/^\.\//, '');
              return (
                <Link href={`/learn/${slug}`} className="text-blue-400 hover:text-blue-300">
                  {children}
                </Link>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                {children}
              </a>
            );
          },
        }}
      >{content}</ReactMarkdown>
    </article>
  );
}
