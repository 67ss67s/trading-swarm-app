/**
 * 研究台内嵌的矩阵研究(§9.53 B):新建表单 + 最近列表,点列表或创建后就地打开详情,不另开会话。
 * 与独立路由 #matrix-study(推荐卡还跳它)用同一套组件。
 */
import { useState } from 'react';
import { MatrixStudyCreate } from './create';
import { MatrixStudyDetail } from './detail';
import { MatrixStudyList } from './list';

export function MatrixStudyPanel({ strategy = null }: { strategy?: string | null }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      {openId ? (
        <MatrixStudyDetail id={openId} onBack={() => setOpenId(null)} />
      ) : (
        <>
          <MatrixStudyCreate key={strategy ?? ''} from={null} strategy={strategy} onCreated={(v) => setOpenId(v.id)} />
          <MatrixStudyList limit={10} onOpen={setOpenId} emptyHint />
        </>
      )}
    </div>
  );
}
