# AI 设计工具箱

一套运行在 Adobe Illustrator 中的 CEP 面板，提供常用测量、绘图加工、文字处理和文件导出工具。界面使用中文。

## 功能

- 测量与统计：尺寸标注、线长与孔洞统计。
- 绘图加工：折边、圆台展开、随机填充、螺旋线、沿路径分布、四向镜像、曲线等分。
- 文字处理：批量查找和替换文字。
- 文件导出：顶层对象批量导出、另存为 Illustrator 3 格式。

另存为 AI3 会将当前文档切换到新文件；旧格式可能影响效果和多画板，请保留原文件。

## 安装

从仓库下载源码并完整解压。在 Windows 上，保存工作并关闭 Illustrator，然后在解压后的项目文件夹中运行 `install.bat`。重新打开 Illustrator，在「窗口 → 扩展（或扩展（旧版））→ AI 设计工具箱」打开面板。安装器会配置当前用户的 CEP 未签名扩展模式，详见 [安装说明](安装说明.md)。

项目清单允许 Illustrator CC 2019（23.0）及以上的 CEP 宿主；具体版本兼容性需实测。macOS 手动安装方法及其他注意事项见 [安装说明](安装说明.md)。

## 开发与测试

需要 Node.js 运行自动测试和语法检查：

```sh
npm test
npm run check
```

这些测试不能替代在 Illustrator 中的实际功能验证。Windows 安装包可用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1` 构建；生成文件放在 `dist/`，不纳入源码仓库。构建会覆盖同名安装包。

