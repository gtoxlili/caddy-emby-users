import { useState } from 'react'
import { Button } from '../ui/button'
import { Segmented } from '../ui/segmented'
import { Loading } from '../ui/spinner'
import type { Kind } from './activity-list'
import { ActivityList, kindOf, kinds } from './activity-list'
import { useActivity } from './data'
import { PageTitle, Panel } from './shell'

type Filter = Kind | 'all'

export default function Activity() {
    const activity = useActivity()
    const [filter, setFilter] = useState<Filter>('all')
    const all = activity.data?.pages.flatMap(p => p.Items) ?? []
    const items = filter === 'all' ? all : all.filter(e => kindOf(e) === filter)
    const total = activity.data?.pages[0]?.TotalRecordCount ?? 0
    return (
        <>
            <PageTitle
                hint="登录、登录失败、播放和账号变动。同一个人半小时内接着看同一部片子只记一条，只留 90 天。"
                aside={
                    <Segmented
                        label="类别"
                        size="sm"
                        value={filter}
                        onChange={setFilter}
                        options={[
                            { value: 'all', label: '全部' },
                            ...(Object.keys(kinds) as Kind[]).map(k => ({ value: k, label: kinds[k].label })),
                        ]}
                    />
                }
            >
                动态
            </PageTitle>
            <Panel>
                {activity.isPending ? <Loading /> : <ActivityList items={items} />}
                {activity.hasNextPage && (
                    <div className="mt-6 flex justify-center">
                        <Button loading={activity.isFetchingNextPage} onClick={() => activity.fetchNextPage()}>
                            再看更早的
                        </Button>
                    </div>
                )}
                {!activity.hasNextPage && all.length > 0 && (
                    <p className="mt-6 text-center text-[12.5px] text-(--text-3) tabular">一共 {total} 条，到头了</p>
                )}
            </Panel>
        </>
    )
}
