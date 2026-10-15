# 开发与部署

[README](../README.md) · [English](development.en.md)

## 本地运行

需要 Node.js 22.12 或以上。

```sh
npm ci
npm run dev
```

打开 <http://127.0.0.1:8787>。本地开发使用公开的测试签名密钥，数据保存在忽略提交的 `.wrangler/`，不绑定公网域名。手机通过普通 HTTP 局域网地址访问通常无法定位，实机测试应使用 HTTPS。

## 部署到 Cloudflare

网页与 API 同域托管在 Cloudflare Workers，使用静态资源、SQLite Durable Objects 和原生限流绑定。

1. 修改 `wrangler.jsonc` 中的 Worker 名称、`routes` 和 `PUBLIC_ORIGIN`。自定义域名的 zone 必须属于部署账号且已激活。`workers.dev` 和预览网址默认关闭。
2. **新部署**将 `LEGACY_CAPABILITIES_UNTIL` 设为空字符串。仓库中的固定截止时间仅供原部署升级时兼容旧链接，不要随每次更新延长。
3. 登录并首次生成服务端签名密钥，再部署：

```sh
npx wrangler login
npm run signing:setup
npm run deploy
```

`signing:setup` 生成 256 位随机密钥，通过标准输入存为 Worker secret `CAPABILITY_KEY`，不打印或写入仓库。它是服务端配置，用户无需填写口令。**仅首次配置时执行**：再次运行会轮换密钥，让现有的新签名链接失效。日常更新只执行 `npm run deploy`。缺少密钥时创建失败且不会写入请求记录。

当前正式站点使用 `location.pizzasend.dpdns.org`，仅绑定 `location-share` Worker。PizzaSend 使用另一个子域名和 Worker；两项目存储及限流独立，同账号的平台总额度仍可能共享。不要提交 Cloudflare 凭据或生产密钥。

## 检查与维护

```sh
npm run check
npm test
npx playwright install chromium webkit
npm run test:browser
npm run build
```

- `check` 检查 JavaScript 语法、本地浏览器库与锁定依赖的一致性，以及静态/API 安全头同步。
- 浏览器测试使用临时隔离状态与模拟坐标，拦截第三方地图资源，不采集真人位置。WebKit 通过不等于 iPhone 实机验证。
- `build` 只打包验证，不发布。GitHub 自动验证执行相同检查。
- 更新依赖后运行 `npm run vendor:sync`；修改 `src/security.js` 后运行 `npm run headers:sync`。本地托管的库保留许可证；MapLibre 适配组件仅调整模块导入路径。

## 实现与边界

- **位置快照**：明确点击允许后定位，`enableHighAccuracy: true` 不能绕过系统权限。估算精度半径超过 100 米时先询问，再按选择处理；100 米不是系统精确位置权限的判断标准。样本超过五分钟不能上传，不保存连续轨迹。
- **访问权限**：提交和查看凭据角色分离，使用 HMAC-SHA-256 签名，在数据库访问前校验。凭据放在网址片段，记录仅保存摘要；验证成功后，标签页以 `sessionStorage` 留存权限并清理地址栏。存储不可用时保留原始完整链接。
- **存储与清理**：事务保护一次提交，相同编号和内容可幂等重试。链接固定一小时，过期立即拒绝访问，后台闹钟清理记录；查看方也可提前删除。HTTPS 传输，无端到端加密，不承诺平台备份同步永久擦除。
- **防滥用**：每来源有效创建最多 5 次/分钟、全站 300 次/UTC 日；另有来源、链接及记录限流，4 KiB 正文上限和 5 秒正文读取截止。IPv6 按 /64 归并。公开创建仍可能被占用额度，边缘限流按节点计数，不等于精确全网配额或 DDoS 免疫。详见 [安全审查](security-review.md)。
- **地图**：Leaflet、MapLibre 和二维码库本地托管；默认 OpenFreeMap Positron 定制北欧浅色，另有 Liberty 与 Dark。只有收到位置后加载矢量组件。无 WebGL2、初始化失败或加载超过 12 秒时回退到 OSM 基础瓦片；底图失败及极区位置仍可查看坐标、打开地图 APP。
- **坐标与外部服务**：高德明确使用 `coordinate=wgs84`，百度使用 `coord_type=wgs84`；手机百度提供原生链接及网页版后备。APP 调起取决于设备和安装情况。地图服务会收到设备网络信息及请求区域；本站片段凭据不放入外部地图链接或 Referer。

锁屏、后台切换、网页被系统释放或断网可能中断定位与上传；取消仅阻止尚未开始的上传。大陆不同网络和 iPhone/Android 实机体验需要实测，见 [验证范围](validation.md)。

## 参考

[W3C Geolocation](https://www.w3.org/TR/geolocation/) · [iPhone 位置权限](https://support.apple.com/zh-cn/102647) · [Android 位置权限](https://support.google.com/pixelphone/answer/9083622?hl=zh-Hans)

[MapLibre](https://maplibre.org/maplibre-gl-js/docs/) · [Leaflet](https://leafletjs.com/reference.html) · [OSM 瓦片政策](https://operations.osmfoundation.org/policies/tiles/) · [高德](https://lbs.amap.com/api/uri-api/guide/mobile-web/point) · [百度](https://lbs.baidu.com/docs/webapi?title=mapadjustment/uri/web) · [Google Maps](https://developers.google.com/maps/documentation/urls/get-started) · [Apple Maps](https://developer.apple.com/documentation/mapkit/unified-map-urls)
