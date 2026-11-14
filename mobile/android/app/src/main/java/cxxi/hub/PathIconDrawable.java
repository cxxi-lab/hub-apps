package cxxi.hub;

import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;

import androidx.core.graphics.PathParser;

/**
 * A Font Awesome icon handed over by the web layer (viewBox size + SVG path
 * data), drawn in one colour, centred and scaled to fit its bounds.
 */
final class PathIconDrawable extends Drawable {

    private final Path path;
    private final float viewWidth;
    private final float viewHeight;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

    PathIconDrawable(float viewWidth, float viewHeight, String pathData, int color) {
        this.path = PathParser.createPathFromPathData(pathData);
        this.viewWidth = viewWidth;
        this.viewHeight = viewHeight;
        paint.setColor(color);
        paint.setStyle(Paint.Style.FILL);
    }

    void setColor(int color) {
        paint.setColor(color);
        invalidateSelf();
    }

    @Override
    public void draw(Canvas canvas) {
        Rect b = getBounds();
        if (b.isEmpty() || viewWidth <= 0 || viewHeight <= 0) return;
        float scale = Math.min(b.width() / viewWidth, b.height() / viewHeight);
        canvas.save();
        canvas.translate(b.left + (b.width() - viewWidth * scale) / 2f, b.top + (b.height() - viewHeight * scale) / 2f);
        canvas.scale(scale, scale);
        canvas.drawPath(path, paint);
        canvas.restore();
    }

    @Override
    public void setAlpha(int alpha) {
        paint.setAlpha(alpha);
        invalidateSelf();
    }

    @Override
    public void setColorFilter(ColorFilter colorFilter) {
        paint.setColorFilter(colorFilter);
        invalidateSelf();
    }

    @Override
    public int getOpacity() {
        return PixelFormat.TRANSLUCENT;
    }
}
