// Translate only application-authored messages. User content and path suffixes
// are never run through a general translation or replacement pass.
const english = new Map([
  ['分组格式无效', 'The groups have an invalid format.'],
  ['分组名称为空或重复', 'Group names must be nonempty and unique.'],
  ['任务分组不存在', 'The task group no longer exists.'],
  ['内容超过大小限制', 'The request exceeds the size limit.'],
  ['仅支持本机访问', 'Only local access is supported.'],
  ['拒绝来自其他网站的修改请求', 'Changes from other websites are not allowed.'],
  ['拒绝其他网站访问本地 MCP', 'Other websites cannot access the local MCP service.'],
  ['无法识别 MCP 请求', 'The MCP request is not valid JSON.'],
  ['无法识别工作区改动', 'The workspace changes are not valid JSON.'],
  ['无法识别工作区数据', 'The workspace data is not valid JSON.'],
  ['直接打开文件目前支持 Windows 和 macOS。', 'Opening files directly is supported on Windows and macOS.'],
  ['直接打开文件夹目前支持 Windows 和 macOS。', 'Opening folders directly is supported on Windows and macOS.'],
  ['无法识别文件操作请求。', 'The file action request is not valid JSON.'],
  ['请指定已保存的文件卡片和操作。', 'Choose a saved file card and a valid action.'],
  ['文件卡片不存在。', 'The file card no longer exists.'],
  ['该卡片不是附件或本地文件。', 'This card is not an attachment or a local file.'],
  ['附件不存在或不属于当前任务。', 'The attachment does not exist or belongs to another task.'],
  ['无法识别文件夹请求。', 'The folder request is not valid JSON.'],
  ['文件夹请求格式无效。', 'The folder request has an invalid format.'],
  ['请指定文件夹卡片。', 'Choose a folder card.'],
  ['文件夹卡片不存在。', 'The folder card no longer exists.'],
  ['该卡片不是本地文件夹。', 'This card is not a local folder.'],
  ['内容不存在', 'The requested item was not found.'],
  ['无效的标识', 'The identifier is invalid.'],
  ['内容格式无效或过长', 'The content has an invalid format or exceeds the length limit.'],
  ['工作区数据格式无效', 'The workspace data has an invalid format.'],
  ['任务标识重复', 'Task IDs must be unique.'], ['任务格式无效', 'The task has an invalid format.'],
  ['卡片标识重复', 'Card IDs must be unique.'], ['卡片格式无效', 'The card has an invalid format.'],
  ['文件夹标记格式无效', 'The folder flag has an invalid format.'],
  ['文件夹路径仅适用于链接卡片', 'Folder paths can only be used on link cards.'],
  ['本地文件标记格式无效', 'The local file flag has an invalid format.'],
  ['本地文件路径仅适用于文件引用', 'Local file paths can only be used for file references.'],
  ['本地文件引用不能同时使用附件副本', 'A local file reference cannot also use an attachment copy.'],
  ['待办格式无效', 'The to-do list has an invalid format.'],
  ['连线格式无效', 'The connection has an invalid format.'],
  ['画布视图无效', 'The canvas view is invalid.'], ['选中任务不存在', 'The selected task no longer exists.'],
  ['无法读取本地数据，请保留 data 文件夹并检查 state.json', 'Local data could not be read. Keep the data folder and check state.json.'],
  ['保存失败，部分 Markdown 导出副本无法还原。请保留 data 文件夹并检查磁盘空间或权限。', 'Saving failed and some exported Markdown copies could not be restored. Keep the data folder and check disk space and permissions.'],
  ['数据版本已更新，请导出当前内容后刷新页面，避免覆盖其他窗口的修改。', 'The workspace has changed. Export your current content, then reload to avoid overwriting another window\'s changes.'],
  ['版本已更新，请重新读取任务后再修改。', 'The workspace has changed. Read the task again before editing it.'],
  ['请先保存任务再上传附件', 'Save the task before uploading an attachment.'],
  ['文件名无效或文件超过 25 MB', 'The filename is invalid or the file exceeds 25 MB.'],
  ['附件保存失败且无法完整清理，请保留 data 文件夹并检查磁盘空间或权限。', 'The attachment could not be saved or fully cleaned up. Keep the data folder and check disk space and permissions.'],
  ['附件不存在', 'The attachment was not found.'],
  ['示例语言初始化失败，无法完整还原示例附件。请保留 data 文件夹并检查磁盘空间或权限。', 'The sample language could not be initialized and its attachments could not be fully restored. Keep the data folder and check disk space and permissions.'],
  ['该路径不是文件，请填写完整文件路径。', 'This path is not a file. Enter the full path to a file.'],
  ['此类型可能运行程序，请通过“打开所在文件夹”自行查看。', 'This file type may run a program. Use “Show in folder” to inspect it yourself.'],
  ['本地服务暂时无法完成操作，请重试。', 'The local service could not complete this action. Please try again.']
]);
const changeReasons = new Map([
  ['数据项过多', 'too many data items'], ['数据嵌套过深', 'data is nested too deeply'],
  ['数字必须有限', 'numbers must be finite'], ['只支持 JSON 值', 'only JSON values are supported'],
  ['不支持循环引用', 'circular references are not supported'], ['只支持普通对象', 'only plain objects are supported'],
  ['不支持 Symbol 字段', 'Symbol properties are not supported'], ['数组包含额外字段', 'arrays cannot have extra properties'],
  ['数组过大', 'the array is too large'], ['数组不允许空位或访问器', 'arrays cannot have holes or accessors'],
  ['ID 数组不能混合其他值', 'ID arrays cannot mix in other value types'], ['ID 无效或重复', 'an ID is invalid or duplicated'],
  ['禁止的对象字段', 'an object property is not allowed'], ['对象不允许隐藏字段或访问器', 'objects cannot have hidden properties or accessors'],
  ['工作区根字段无效', 'the workspace root fields are invalid'], ['路径无效', 'the path is invalid'],
  ['路径字段无效', 'a path field is invalid'], ['不能直接修改实体 ID', 'entity IDs cannot be changed directly'],
  ['ID 路径无效', 'the ID path is invalid'], ['activeTaskId 不能有子路径', 'activeTaskId cannot have a child path'],
  ['任务必须按 ID 寻址', 'tasks must be addressed by ID'], ['操作数量无效', 'the operation count is invalid'],
  ['更改超过 16 MiB', 'the changes exceed 16 MiB'], ['未知操作', 'the operation is unknown'],
  ['set 操作字段无效', 'the set operation has invalid fields'], ['任务集合必须按 ID 修改', 'tasks must be changed by ID'],
  ['重复写入同一路径', 'the same path is written more than once'], ['实体值必须匹配路径 ID', 'the entity value must match the path ID'],
  ['活动记录不能通过增量删除', 'activity history cannot be deleted by a change request'],
  ['排序操作无效', 'the ordering operation is invalid'], ['重复或无效的排序路径', 'an ordering path is duplicated or invalid'],
  ['父子写入路径相交', 'parent and child write paths overlap'], ['排序与替换路径相交', 'ordering and replacement paths overlap'],
  ['操作数量过多', 'there are too many operations'], ['字段路径不能用于数组或标量', 'field paths cannot address arrays or scalar values'],
  ['ID 路径必须用于实体数组', 'ID paths must address entity arrays'],
  ['不能删除选中任务或画布视图', 'the selected task field and canvas view cannot be deleted'],
  ['更新时间必须是字符串', 'the update time must be a string'], ['只能对实体数组排序', 'only entity arrays can be reordered'],
  ['活动记录缺少时间', 'an activity record is missing its timestamp']
]);
const pathPrefixes = [
  ['文件夹不存在：', 'Folder not found: '], ['路径不是文件夹：', 'The path is not a folder: '],
  ['无法访问文件夹，请检查路径和权限：', 'The folder cannot be accessed. Check its path and permissions: '],
  ['该路径是文件，请填写文件夹路径：', 'This path is a file. Enter a folder path: '],
  ['数据目录：', 'Data folder: '],
  ['文件不存在或已移动，请检查路径：', 'The file does not exist or has moved. Check its path: '],
  ['无法访问文件，请检查权限：', 'The file cannot be accessed. Check its permissions: '],
  ['无法打开 Finder，请手动打开文件夹：', 'Finder could not be opened. Open this folder manually: '],
  ['无法启动资源管理器，请手动打开文件夹：', 'File Explorer could not be started. Open this folder manually: '],
  ['无法在 Finder 中定位文件，请手动查看：', 'The file could not be revealed in Finder. Locate it manually: '],
  ['无法用默认程序打开文件，请手动查看：', 'The file could not be opened with its default app. Locate it manually: '],
  ['无法打开所在文件夹，请手动定位：', 'The containing folder could not be opened. Locate the file manually: '],
  ['无法用默认程序打开文件，请检查文件关联，或使用“打开所在文件夹”：', 'The file could not be opened with its default app. Check file associations or use “Show in folder”: ']
];
const fallback = 'The local service could not complete this action. Please try again.';

export function requestLocale(header) {
  if (typeof header !== 'string') return 'zh-CN';
  const languages = header.slice(0, 1024).split(',').map((entry, index) => {
    const [language, ...parameters] = entry.trim().toLowerCase().split(';');
    const quality = parameters.find(parameter => parameter.trim().startsWith('q='));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    return {language, q:Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0, index};
  }).filter(entry => entry.q > 0).sort((a, b) => b.q - a.q || a.index - b.index);
  for (const {language} of languages) {
    if (/^en(?:-|$)/.test(language)) return 'en';
    if (/^zh(?:-|$)/.test(language)) return 'zh-CN';
  }
  return 'zh-CN';
}

export function localizeMessage(message, locale = 'zh-CN') {
  if (locale !== 'en') return message;
  if (english.has(message)) return english.get(message);
  for (const [source, translated] of pathPrefixes) if (message.startsWith(source)) return translated + message.slice(source.length);
  const kind = /^请先填写(文件夹|文件)的完整路径。$/.exec(message);
  if (kind) return 'Enter the full path to the ' + (kind[1] === '文件夹' ? 'folder' : 'file') + '.';
  const example = /^请填写本机完整(文件夹|文件)路径，例如 (.+)。$/.exec(message);
  if (example) return 'Enter a full local ' + (example[1] === '文件夹' ? 'folder' : 'file') + ' path, such as ' + (example[2].startsWith('/') ? '/Users/your-name/Documents/files' : 'D:\\files') + '.';
  const conflictPrefix = '网页与其他窗口或 AI 同时修改了相同内容：';
  if (message.startsWith(conflictPrefix)) {
    const field = message.slice(conflictPrefix.length);
    return 'The same content was changed in another window or by AI: ' + (field === '卡片关联' ? 'card connections' : field);
  }
  const changesPrefix = '增量数据无效：';
  if (message.startsWith(changesPrefix)) return 'Invalid workspace changes: ' + (changeReasons.get(message.slice(changesPrefix.length)) ?? 'the change request is invalid') + '.';
  return fallback;
}

export function localizedError(error, locale = 'zh-CN') {
  const message = error?.status ? error.message : '本地服务暂时无法完成操作，请重试。';
  return localizeMessage(typeof message === 'string' ? message : '本地服务暂时无法完成操作，请重试。', locale);
}
