package cxxi.hub;

import android.content.Context;
import android.view.View;
import android.view.ViewGroup;

/** Lays its children out in centred rows that wrap, like CSS flex-wrap (the tag chips). */
final class FlowLayout extends ViewGroup {

    private final int gap;

    FlowLayout(Context context, int gap) {
        super(context);
        this.gap = gap;
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int maxWidth = MeasureSpec.getSize(widthMeasureSpec) - getPaddingLeft() - getPaddingRight();
        int rowWidth = 0;
        int rowHeight = 0;
        int height = 0;
        for (int i = 0; i < getChildCount(); i++) {
            View child = getChildAt(i);
            child.measure(MeasureSpec.makeMeasureSpec(maxWidth, MeasureSpec.AT_MOST), MeasureSpec.UNSPECIFIED);
            int w = child.getMeasuredWidth();
            if (rowWidth > 0 && rowWidth + gap + w > maxWidth) {
                height += rowHeight + gap;
                rowWidth = 0;
                rowHeight = 0;
            }
            rowWidth += (rowWidth > 0 ? gap : 0) + w;
            rowHeight = Math.max(rowHeight, child.getMeasuredHeight());
        }
        height += rowHeight + getPaddingTop() + getPaddingBottom();
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), resolveSize(height, heightMeasureSpec));
    }

    @Override
    protected void onLayout(boolean changed, int l, int t, int r, int b) {
        int maxWidth = r - l - getPaddingLeft() - getPaddingRight();
        int y = getPaddingTop();
        int start = 0;
        while (start < getChildCount()) {
            // Gather one row, then place it centred.
            int end = start;
            int rowWidth = 0;
            int rowHeight = 0;
            while (end < getChildCount()) {
                int w = getChildAt(end).getMeasuredWidth();
                if (end > start && rowWidth + gap + w > maxWidth) break;
                rowWidth += (end > start ? gap : 0) + w;
                rowHeight = Math.max(rowHeight, getChildAt(end).getMeasuredHeight());
                end++;
            }
            int x = getPaddingLeft() + (maxWidth - rowWidth) / 2;
            for (int i = start; i < end; i++) {
                View child = getChildAt(i);
                child.layout(x, y, x + child.getMeasuredWidth(), y + child.getMeasuredHeight());
                x += child.getMeasuredWidth() + gap;
            }
            y += rowHeight + gap;
            start = end;
        }
    }
}
