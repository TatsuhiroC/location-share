<div align="center">
  <img src="public/icon.svg" width="88" height="88" alt="在这里 · Location Share">
  <h1>在这里 · Location Share</h1>
  <p>一次分享，刚刚好。</p>
  <p>
    <a href="https://location.pizzasend.dpdns.org/"><img src="https://img.shields.io/badge/%E7%BD%91%E9%A1%B5%E7%89%88-%E6%89%93%E5%BC%80%E5%BA%94%E7%94%A8-59836a?style=flat-square&amp;labelColor=245b48" alt="打开网页版"></a>
    <a href="https://github.com/TatsuhiroC/location-share/actions/workflows/verify.yml"><img src="https://github.com/TatsuhiroC/location-share/actions/workflows/verify.yml/badge.svg" alt="自动验证"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-59836a?style=flat-square&amp;labelColor=245b48" alt="MIT"></a>
  </p>
  <p><a href="README.md">简体中文</a> · <a href="README_EN.md">English</a> · <a href="https://github.com/TatsuhiroC/location-share/issues">反馈问题</a></p>
</div>

把链接或二维码发给对方。对方明确允许后，你在原页面看到一次当前位置，**无需安装应用，不持续跟踪**。

![在这里：生成临时位置分享链接](docs/images/readme-home.png)

## 能做什么

- **链接或扫码分享**：发起人名字可选，链接固定 1 小时有效。
- **允许后才定位**：精度较低时，可重新获取、确认发送大致位置或取消。
- **在地图上查看**：基于 OpenStreetMap，提供北欧浅色、柔和街道和深色底图。
- **用地图 APP 打开**：支持高德、百度、Google 和苹果地图。
- **随时结束**：查看方可提前删除记录，让分享和查看链接失效。

## 三步开始

1. **生成链接**：打开网页，可选填写「分享发起人」。
2. **发给对方**：发送链接或二维码，保留当前页面。
3. **对方允许**：对方打开链接并允许定位后，你的页面自动显示位置。

专属查看链接可留存备用；持有它的人能查看和删除位置，请妥善保管。

## 常见问题

**需要联网吗？** 需要。首次打开、发送位置和加载地图都依赖网络。

**位置一定准确吗？** 不一定。精度由设备、系统权限和信号决定；页面显示估算范围，并提供精确位置设置指引，不能保证 GPS 精度或坐标真实性。

**位置会公开吗？** 本站不公开展示位置，查看需要专属链接。位置通过 HTTPS 发送至服务端，未做端到端加密，部署管理员可访问存储。到期后由后台清理活动记录；地图服务会看到设备网络信息和请求区域。

[开发与部署](docs/development.md) · [安全审查](docs/security-review.md) · [验证记录与更多截图](docs/validation.md)

## 致谢

使用 [OpenStreetMap](https://www.openstreetmap.org/copyright)、[OpenFreeMap](https://openfreemap.org/)、[Leaflet](https://leafletjs.com/) 和 [MapLibre](https://maplibre.org/)；参考 [LocWatch](https://github.com/TatsuhiroC/locwatch) 与 [PizzaSend](https://github.com/TatsuhiroC/pizza-send)，独立实现。

[MIT](LICENSE) · Copyright © 2026 TatsuhiroC · 第三方许可证见 [public/vendor](public/vendor/)
