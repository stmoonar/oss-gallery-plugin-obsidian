# Obsidian OSS Gallery 插件

### [English](./README.md) | 中文

这个仓库是从 [Obsidian Minio Uploader Plugin](https://github.com/seebin/obsidian-minio-uploader-plugin) fork 过来的，扩展了多存储提供商支持并添加了新功能。

## 支持的存储提供商
- **MinIO** — 自托管的 S3 兼容对象存储
- **SM.MS** — 免费图床
- **GitHub** — 上传到 GitHub 仓库
- **阿里云 OSS** — 阿里云对象存储服务
- **腾讯云 COS** — 腾讯云对象存储
- **七牛云 Kodo** — 七牛云存储
- **又拍云 USS** — 又拍云存储
- **Imgur** — 匿名图床

## 特性
- 支持拖拽文件到编辑器后直接上传到已配置的存储提供商
- 支持粘贴文件到编辑器后直接上传
- 命令面板文件上传（支持图片、视频、音频和文档文件）
- 支持多种文件类型预览：
  - 图片预览
  - 视频预览
  - 音频预览
  - 文档预览（Google Docs/Office Online）
- 图片库视图：
  - 网格布局查看所有已上传图片
  - 通过 URL 搜索图片（支持正则和通配符模式）
  - 一键复制图片 URL
  - 直接从图片库中删除图片
  - 全屏预览图片
- 智能图片库优化：
  - LRU 缓存策略提升性能
  - 懒加载优化（Intersection Observer）
  - 回到顶部按钮
  - 批量渲染优化
  - 内存管理和清理
- 增强图片预览体验：
  - 硬件加速的流畅动画
  - 点击背景关闭预览
  - ESC 键退出预览
  - 优化拖拽性能

![上传](./minio-upload.gif)
---
![删除](./minio-delete.gif)

## 设置

在插件设置中选择你偏好的存储提供商，然后配置对应的提供商设置。

### MinIO

> 提示：端口号为 MinIO 的 API 数据访问端口号

- accessKey
- secretKey
- bucket
- endpoint
- port
- SSL
- 自定义域名（可选）

需要在 MinIO 控制台的 Bucket 设置中开启文件匿名访问能力，即通过 URL 可直接访问文件。

![设置](./minio-bucket-setting.png)

### SM.MS
- API Token

### GitHub
- 仓库（格式：`owner/repo`）
- 分支
- Token（个人访问令牌）
- 自定义 URL（可选，用于 CDN 如 jsDelivr）

### 阿里云 OSS
- Access Key ID
- Access Key Secret
- Bucket
- 地域（如 `oss-cn-hangzhou`）
- 路径前缀（可选）
- 自定义域名（可选，用于 CDN 加速）

### 腾讯云 COS
- Secret ID
- Secret Key
- Bucket
- 地域（如 `ap-shanghai`）
- 路径前缀（可选）
- 自定义域名（可选）

### 七牛云 Kodo
- Access Key
- Secret Key
- Bucket
- CDN 域名 URL
- 存储区域
- 路径前缀（可选）

### 又拍云 USS
- 操作员名称
- 密码
- 服务名称（Bucket）
- 加速域名 URL
- 路径前缀（可选）
- 图片处理后缀（可选）

### Imgur
- Client ID
- 代理 URL（可选，部分地区需要）
