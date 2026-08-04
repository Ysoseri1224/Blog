import { describe, expect, it } from 'vitest';
import { isStaticAsset } from '../src/worker/index';

describe('静态资源路由', () => {
  it('将站点字标交给静态资源绑定处理', () => {
    expect(isStaticAsset('/yso-wordmark-mask.png')).toBe(true);
  });

  it('不会把公共文章路径误判为静态资源', () => {
    expect(isStaticAsset('/life/blog')).toBe(false);
  });
});
